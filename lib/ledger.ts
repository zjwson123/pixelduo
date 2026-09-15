import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

export type LedgerType =
  | "SIGNUP_BONUS"
  | "CHECKIN"
  | "PURCHASE"
  | "SUBSCRIPTION"
  | "PRE_AUTH"
  | "SETTLE"
  | "REFUND"
  | "REVOKE"
  | "ROLLOVER"
  | "EXPIRE"
  | "ADMIN";

// Credit grants carry expiry per commercial policy:
// - PURCHASE (packs): valid 12 months
// - SUBSCRIPTION (monthly quota): valid until the cycle end (planRenewsAt)
// - ROLLOVER (30% carryover): valid only until the following cycle end
// - SIGNUP_BONUS / CHECKIN (free): never expire
export type GrantSource = "SIGNUP_BONUS" | "CHECKIN" | "PURCHASE" | "SUBSCRIPTION" | "ROLLOVER" | "ADMIN" | "REFUND";

export interface SpendConsumption {
  grantId: string;
  amount: number;
}

export const PACK_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000; // 12 months
export const ROLLOVER_RATE = 0.3;

export interface CycleUsage {
  granted: number;
  spentNet: number;
  revoked: number;
}

// Free credits are consumed first so paid credits can never be diluted by
// free ones (anti-abuse: free pool cannot be hoarded while burning paid).
const FREE_SOURCES = new Set<string>(["SIGNUP_BONUS", "CHECKIN", "ADMIN"]);

export async function addCreditsTx(
  tx: Prisma.TransactionClient,
  userId: string,
  type: LedgerType,
  delta: number,
  refType?: string | null,
  refId?: string | null,
  note?: string | null,
) {
  // Atomic DB-side increment. A read-modify-write here loses updates whenever
  // a grant (checkin/webhook/refund) races a concurrent spend that doesn't
  // hold the grant locks — the last writer's absolute overwrite would erase
  // the other's delta and break credits == SUM(remaining). update() returns
  // the post-write row, which is the correct balanceAfter under concurrency.
  let user: { credits: number };
  try {
    user = await tx.user.update({
      where: { id: userId },
      data: { credits: { increment: delta } },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      throw new Error("user-not-found");
    }
    throw e;
  }
  const balanceAfter = user.credits;
  if (balanceAfter < 0) throw new Error("insufficient-credits");
  return tx.ledgerEntry.create({
    data: { userId, type, creditsDelta: delta, balanceAfter, refType, refId, note },
  });
}

// Grant credits into a fresh CreditGrant row (invariant: credits == SUM(remaining)).
export async function grantCreditsTx(
  tx: Prisma.TransactionClient,
  userId: string,
  source: GrantSource,
  amount: number,
  expiresAt: Date | null,
  refType?: string | null,
  refId?: string | null,
  note?: string | null,
) {
  if (amount <= 0) return;
  await tx.creditGrant.create({
    data: { userId, source, amount, remaining: amount, expiresAt, refType, refId },
  });
  await addCreditsTx(tx, userId, source, amount, refType, refId, note);
}

// Canonical grant-lock order. EVERY statement that locks CreditGrant rows must
// acquire them in this sequence: two transactions locking the same rows in
// opposite orders deadlock, and Postgres resolves that by aborting one (a 500
// on a webhook or an admin action). It matches the FIFO spend order, so
// spendCreditsTx can take the rows in the order they come back.
const GRANT_LOCK_ORDER = Prisma.sql`ORDER BY CASE WHEN source IN ('SIGNUP_BONUS', 'CHECKIN') THEN 0 ELSE 1 END,
               "expiresAt" ASC NULLS LAST, "createdAt" ASC`;

// Credits granted, pre-authed and refunded inside one billing cycle, used to
// compute unused quota for the 30% carryover at renewal time.
export async function cycleUsageTx(
  tx: Prisma.TransactionClient,
  userId: string,
  cycleStart: Date,
): Promise<CycleUsage> {
  const entries = await tx.ledgerEntry.findMany({
    where: { userId, createdAt: { gte: cycleStart } },
    select: { type: true, creditsDelta: true, refId: true },
  });
  // Only clawbacks of THIS cycle's own plan quota may reduce its unused quota.
  // The previous version summed every REVOKE and EXPIRE in the window, so a
  // refunded credit PACK (~6000 credits) silently ate the whole carryover, and
  // an unrelated EXPIRE (the previous cycle's rollover grant, which is never
  // counted in `granted`) did the same — both in the customer's disfavour.
  // Scoping to the orders that funded this cycle's SUBSCRIPTION grants keeps
  // the refunded-plan protection while dropping the collateral damage.
  const cycleGrants = await tx.creditGrant.findMany({
    where: { userId, source: "SUBSCRIPTION", createdAt: { gte: cycleStart } },
    select: { refId: true },
  });
  const cycleOrderIds = new Set(
    cycleGrants.map((g) => g.refId).filter((id): id is string => Boolean(id)),
  );
  let granted = 0;
  let preAuth = 0;
  let refund = 0;
  let revoked = 0;
  for (const e of entries) {
    if (e.type === "SUBSCRIPTION" && e.creditsDelta > 0) granted += e.creditsDelta;
    if (e.type === "PRE_AUTH") preAuth += Math.abs(e.creditsDelta);
    if (e.type === "REFUND") refund += e.creditsDelta;
    // Clawed-back (REVOKE) quota is gone: counting only PRE_AUTH/REFUND
    // treated a fully refunded cycle as "granted and unused", so the next
    // purchase collected 30% carryover on credits the user had already been
    // refunded for — repeatable every cycle. EXPIRE is deliberately NOT
    // counted: that is bookkeeping for credits whose validity already ended
    // at the cycle boundary, and including it made the carryover depend on
    // whether the expiry sweep happened to run before the renewal.
    if (e.type === "REVOKE" && e.refId && cycleOrderIds.has(e.refId)) {
      revoked += Math.abs(e.creditsDelta);
    }
  }
  return { granted, spentNet: Math.max(0, preAuth - refund), revoked };
}

export async function cycleUsage(userId: string, cycleStart: Date): Promise<CycleUsage> {
  return cycleUsageTx(prisma, userId, cycleStart);
}

// Spend credits FIFO: free sources first, then earliest expiry (null last).
// Rows are locked FOR UPDATE so concurrent spends cannot overspend. Expired
// grants are excluded here too — the daily sweep is the bookkeeping pass, but
// spendability must end at expiresAt itself, not up to a day later.
export async function spendCreditsTx(
  tx: Prisma.TransactionClient,
  userId: string,
  amount: number,
  refType?: string | null,
  refId?: string | null,
  note?: string | null,
): Promise<SpendConsumption[]> {
  if (amount <= 0) return [];
  const rows = await tx.$queryRaw<Array<{ id: string; remaining: number }>>(
    Prisma.sql`SELECT id, remaining FROM "CreditGrant"
      WHERE "userId" = ${userId} AND remaining > 0
        AND ("expiresAt" IS NULL OR "expiresAt" > now())
      ${GRANT_LOCK_ORDER}
      FOR UPDATE`,
  );
  let needed = amount;
  const consumption: SpendConsumption[] = [];
  for (const r of rows) {
    if (needed <= 0) break;
    const take = Math.min(r.remaining, needed);
    await tx.creditGrant.update({
      where: { id: r.id },
      data: { remaining: { decrement: take } },
    });
    consumption.push({ grantId: r.id, amount: take });
    needed -= take;
  }
  if (needed > 0) throw new Error("insufficient-credits");
  await addCreditsTx(tx, userId, "PRE_AUTH", -amount, refType, refId, note);
  return consumption;
}

// Refund restores the exact grants consumed by the original pre-auth.
// Grants keep their original expiry (a failed job never extends validity) —
// EXCEPT grants that expired (or vanished) while the job sat in retries:
// the expiry sweep zeroes remaining>0 rows on expired grants and deducts
// them back out of the balance, which would silently swallow the refund.
// The expired portion lands in a fresh non-expiring REFUND grant instead,
// preserving User.credits == SUM(CreditGrant.remaining).
//
// A grant funded by an order that has since been REFUNDED is never restored:
// its credits were already clawed back (or are about to be), so restoring them
// here would leave the customer with both the money and the credits. The
// window is real — a job holds its credits as remaining=0 for as long as it is
// queued/running (up to the video hard timeout), so revokeOrderCreditsTx finds
// nothing to revoke and the later failure refund used to hand it all back.
export async function refundCreditsTx(
  tx: Prisma.TransactionClient,
  userId: string,
  amount: number,
  consumption: SpendConsumption[] | null,
  refType?: string | null,
  refId?: string | null,
  note?: string | null,
) {
  if (amount <= 0) return;
  if (!consumption?.length) {
    // Fallback for jobs created before grant tracking: flat refund. Nothing
    // links these credits to an order, so a refunded order cannot be detected.
    await addCreditsTx(tx, userId, "REFUND", amount, refType, refId, note);
    return;
  }
  // Lock the consumed rows so the expiry sweep serializes with this refund:
  // if the sweep locks first it zeroes the row and the expiry check below
  // (re-read after the lock) routes that portion into the replacement grant.
  // The ORDER BY matches spendCreditsTx so two spends/refunds over the same
  // rows always take the grant locks in the same sequence.
  const rows = await tx.$queryRaw<
    Array<{ id: string; expiresAt: Date | null; refType: string | null; refId: string | null }>
  >(
    Prisma.sql`SELECT id, "expiresAt", "refType", "refId" FROM "CreditGrant"
      WHERE id IN (${Prisma.join(consumption.map((c) => c.grantId))})
      ${GRANT_LOCK_ORDER}
      FOR UPDATE`,
  );
  const orderRefs = [
    ...new Set(
      rows.filter((r) => r.refType === "order" && r.refId).map((r) => r.refId as string),
    ),
  ];
  const refundedOrders = new Set(
    orderRefs.length
      ? (
          await tx.order.findMany({
            where: { id: { in: orderRefs }, status: "refunded" },
            select: { id: true },
          })
        ).map((o) => o.id)
      : [],
  );
  let expiredTotal = 0;
  let revokedTotal = 0;
  for (const c of consumption) {
    const row = rows.find((r) => r.id === c.grantId);
    if (!row) {
      expiredTotal += c.amount;
      continue;
    }
    if (row.refType === "order" && row.refId && refundedOrders.has(row.refId)) {
      revokedTotal += c.amount;
      continue;
    }
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      expiredTotal += c.amount;
      continue;
    }
    await tx.creditGrant.update({
      where: { id: c.grantId },
      data: { remaining: { increment: c.amount } },
    });
  }
  if (expiredTotal > 0) {
    await tx.creditGrant.create({
      data: {
        userId,
        source: "REFUND",
        amount: expiredTotal,
        remaining: expiredTotal,
        expiresAt: null,
        refType: refType ?? null,
        refId: refId ?? null,
      },
    });
  }
  if (amount - revokedTotal > 0) {
    await addCreditsTx(tx, userId, "REFUND", amount - revokedTotal, refType, refId, note);
  }
}

export interface CheckinResult {
  claimed: boolean;
  credits: number;
}

// Check-in day key, computed in a fixed timezone (default Asia/Shanghai) so
// the "day" rolls over at local midnight, not at UTC midnight (08:00 for
// UTC+8 users — which allowed two check-ins in one local day). en-CA yields
// YYYY-MM-DD.
const fmtCache = new Map<string, Intl.DateTimeFormat>();
export function checkinDateKey(now = new Date()): string {
  const tz = process.env.CHECKIN_TIMEZONE || "Asia/Shanghai";
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    fmtCache.set(tz, fmt);
  }
  return fmt.format(now);
}

export async function dailyCheckin(userId: string): Promise<CheckinResult> {
  const date = checkinDateKey();
  return prisma.$transaction(async (tx) => {
    const existing = await tx.checkin.findUnique({
      where: { userId_date: { userId, date } },
    });
    if (existing) return { claimed: false, credits: 0 };
    try {
      await tx.checkin.create({ data: { userId, date, credits: 2 } });
    } catch (e) {
      // Two tabs checking in at once: the @@unique(userId, date) loser is a
      // normal "already claimed today", not a 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return { claimed: false, credits: 0 };
      }
      throw e;
    }
    await grantCreditsTx(tx, userId, "CHECKIN", 2, null, "none", date, "daily check-in");
    return { claimed: true, credits: 2 };
  });
}

export async function signupBonus(userId: string) {
  return prisma.$transaction((tx) =>
    grantCreditsTx(tx, userId, "SIGNUP_BONUS", 30, null, "none", null, "signup bonus"),
  );
}

export async function fulfillOrder(
  userId: string,
  orderId: string,
  kind: "pack" | "plan",
  credits: number,
  planId?: string | null,
  tx?: Prisma.TransactionClient,
) {
  const run = async (client: Prisma.TransactionClient) => {
    // Atomic claim: only the first fulfillment of a pending order wins, so two
    // distinct signed events for the same order (or a retry racing the
    // original) can never both pass the status check and grant credits twice.
    // Claiming strictly from "pending" also blocks re-fulfillment after a
    // refund flips the order to "refunded".
    const claim = await client.order.updateMany({
      where: { id: orderId, status: "pending" },
      data: { status: "paid", paidAt: new Date() },
    });
    if (claim.count === 0) {
      const order = await client.order.findUnique({ where: { id: orderId }, select: { id: true } });
      if (!order) throw new Error("order-not-found");
      return { alreadyPaid: true };
    }
    if (kind === "plan" && planId) {
      // Lock the user row before reading the cycle anchor: two concurrent plan
      // fulfillments (double-clicked checkout, two provider deliveries) both
      // read the same planRenewsAt and both write base+1month, so the second
      // overwrote the first — two paid months produced one, and both
      // SUBSCRIPTION grants expired at the same early date. The lock also
      // serializes the rollover computation, which otherwise ran twice on the
      // same "ended" cycle.
      await client.$queryRaw(Prisma.sql`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`);
      const user = await client.user.findUnique({ where: { id: userId } });
      if (!user) throw new Error("user-not-found");
      const now = new Date();
      // Renewal extends from the current cycle end when bought early, otherwise
      // starts a fresh cycle from now.
      const base = user.planRenewsAt && user.planRenewsAt > now ? user.planRenewsAt : now;
      const renew = new Date(base);
      renew.setMonth(renew.getMonth() + 1);
      // 30% of the unused quota from a just-ended cycle carries into the new
      // one. Only when the previous cycle has actually ended — early renewals
      // keep their remaining quota and wait until the next cycle boundary.
      let rollover = 0;
      let unused = 0;
      if (user.planRenewsAt && user.planRenewsAt <= now) {
        const cycleStart = new Date(user.planRenewsAt);
        cycleStart.setMonth(cycleStart.getMonth() - 1);
        const usage = await cycleUsageTx(client, userId, cycleStart);
        unused = Math.max(0, usage.granted - usage.spentNet - usage.revoked);
        rollover = Math.floor(unused * ROLLOVER_RATE);
      }
      await client.user.update({ where: { id: userId }, data: { plan: planId, planRenewsAt: renew } });
      await grantCreditsTx(client, userId, "SUBSCRIPTION", credits, renew, "order", orderId, `plan ${planId}`);
      if (rollover > 0) {
        await grantCreditsTx(
          client,
          userId,
          "ROLLOVER",
          rollover,
          renew,
          "order",
          orderId,
          `30% of ${unused} unused quota`,
        );
      }
    } else {
      const expiresAt = new Date(Date.now() + PACK_VALIDITY_MS);
      await grantCreditsTx(client, userId, "PURCHASE", credits, expiresAt, "order", orderId, "credit pack");
    }
    return { alreadyPaid: false };
  };
  return tx ? run(tx) : prisma.$transaction(run);
}

// Revoke the credits granted by a specific order when the payment is refunded.
// Only the unspent remainder is revoked; credits already consumed by jobs stay
// spent (a refund can't undo usage). Grants are locked FOR UPDATE (same as
// spendCreditsTx) so a revoke racing a spend sums the post-spend remaining —
// an unlocked read would deduct a stale, larger amount from user credits and
// break credits == SUM(remaining) downward. Callers must have flipped the
// order to "refunded" via a status CAS first, so two distinct refund events
// cannot both reach this code.
export async function revokeOrderCreditsTx(
  tx: Prisma.TransactionClient,
  order: { id: string; userId: string },
): Promise<number> {
  // Lock EVERY grant this order funded, including ones sitting at
  // remaining = 0. The `AND remaining > 0` filter used to run BEFORE the lock,
  // so a grant drained by a queued/running job (exactly the state a job leaves
  // it in) was never locked and never serialized with refundCreditsTx
  // restoring that same grant on a job failure: the restore read the order
  // status without a lock, saw the pre-flip "paid", and handed the credits
  // back while this revoke found nothing to take. Money refunded AND credits
  // kept, permanently — every later refund event finds the order non-paid and
  // is deduped. Locking the row makes the restore wait; the post-lock re-read
  // then sees the restored amount and revokes it. The remaining > 0 test moves
  // into the loop, where it only decides whether there is anything to take.
  // GRANT_LOCK_ORDER keeps this consistent with every other grant-locking
  // statement (without it, a revoke racing a refund could deadlock).
  const grants = await tx.$queryRaw<Array<{ id: string; remaining: number }>>(
    Prisma.sql`SELECT id, remaining FROM "CreditGrant"
      WHERE "refId" = ${order.id}
      ${GRANT_LOCK_ORDER}
      FOR UPDATE`,
  );
  let revoked = 0;
  for (const g of grants) {
    if (g.remaining <= 0) continue;
    await tx.creditGrant.update({ where: { id: g.id }, data: { remaining: 0 } });
    revoked += g.remaining;
  }
  // No spendable remainder (already spent, or drained and revoked elsewhere):
  // nothing to take, so no ledger entry either — a zero-delta REVOKE would
  // just be noise in the cycle-usage window.
  if (revoked <= 0) return 0;
  await addCreditsTx(tx, order.userId, "REVOKE", -revoked, "order", order.id, "credits revoked on payment refund");
  return revoked;
}

// Admin compensation: grant non-expiring credits (consumed first like free
// credits) with an ADMIN ledger entry attributed to the acting admin.
export async function adminGrantTx(
  tx: Prisma.TransactionClient,
  userId: string,
  amount: number,
  note: string,
  adminId: string,
): Promise<void> {
  if (amount <= 0) throw new Error("invalid-amount");
  await grantCreditsTx(tx, userId, "ADMIN", amount, null, "admin", adminId, note);
}

// Admin clawback: remove credits FIFO (free/admin grants first, then by
// earliest expiry). Preserves the invariant User.credits == SUM(remaining).
export async function adminClawbackTx(
  tx: Prisma.TransactionClient,
  userId: string,
  amount: number,
  note: string,
  adminId: string,
): Promise<void> {
  if (amount <= 0) throw new Error("invalid-amount");
  // Rows are LOCKED in the canonical order (GRANT_LOCK_ORDER) so a clawback
  // racing a spend or a refund cannot deadlock, then TAKEN in this endpoint's
  // own semantic order — free/admin grants first, which is deliberately not
  // the FIFO order the lock uses. Locking order and take order are separate
  // concerns; conflating them is what made this differ from spendCreditsTx.
  const rows = await tx.$queryRaw<
    Array<{ id: string; remaining: number; source: string; expiresAt: Date | null; createdAt: Date }>
  >(
    Prisma.sql`SELECT id, remaining, source, "expiresAt", "createdAt" FROM "CreditGrant"
      WHERE "userId" = ${userId} AND remaining > 0
      ${GRANT_LOCK_ORDER}
      FOR UPDATE`,
  );
  const freeFirst = (s: string) => (s === "SIGNUP_BONUS" || s === "CHECKIN" || s === "ADMIN" ? 0 : 1);
  const takeOrder = [...rows].sort((a, b) => {
    const fa = freeFirst(a.source) - freeFirst(b.source);
    if (fa !== 0) return fa;
    const ea = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const eb = b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (ea !== eb) return ea - eb;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  let needed = amount;
  for (const r of takeOrder) {
    if (needed <= 0) break;
    const take = Math.min(r.remaining, needed);
    await tx.creditGrant.update({
      where: { id: r.id },
      data: { remaining: { decrement: take } },
    });
    needed -= take;
  }
  if (needed > 0) throw new Error("insufficient-credits");
  await addCreditsTx(tx, userId, "ADMIN", -amount, "admin", adminId, note);
}
