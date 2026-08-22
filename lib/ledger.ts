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
export type GrantSource = "SIGNUP_BONUS" | "CHECKIN" | "PURCHASE" | "SUBSCRIPTION" | "ROLLOVER" | "ADMIN";

export interface SpendConsumption {
  grantId: string;
  amount: number;
}

export const PACK_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000; // 12 months
export const ROLLOVER_RATE = 0.3;

export interface CycleUsage {
  granted: number;
  spentNet: number;
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
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("user-not-found");
  const balanceAfter = user.credits + delta;
  if (balanceAfter < 0) throw new Error("insufficient-credits");
  await tx.user.update({ where: { id: userId }, data: { credits: balanceAfter } });
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

// Credits granted, pre-authed and refunded inside one billing cycle, used to
// compute unused quota for the 30% carryover at renewal time.
export async function cycleUsageTx(
  tx: Prisma.TransactionClient,
  userId: string,
  cycleStart: Date,
): Promise<CycleUsage> {
  const entries = await tx.ledgerEntry.findMany({
    where: { userId, createdAt: { gte: cycleStart } },
    select: { type: true, creditsDelta: true },
  });
  let granted = 0;
  let preAuth = 0;
  let refund = 0;
  for (const e of entries) {
    if (e.type === "SUBSCRIPTION" && e.creditsDelta > 0) granted += e.creditsDelta;
    if (e.type === "PRE_AUTH") preAuth += Math.abs(e.creditsDelta);
    if (e.type === "REFUND") refund += e.creditsDelta;
  }
  return { granted, spentNet: Math.max(0, preAuth - refund) };
}

export async function cycleUsage(userId: string, cycleStart: Date): Promise<CycleUsage> {
  return cycleUsageTx(prisma, userId, cycleStart);
}

// Spend credits FIFO: free sources first, then earliest expiry (null last).
// Rows are locked FOR UPDATE so concurrent spends cannot overspend.
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
      ORDER BY CASE WHEN source IN ('SIGNUP_BONUS', 'CHECKIN') THEN 0 ELSE 1 END,
               "expiresAt" ASC NULLS LAST, "createdAt" ASC
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
// Grants keep their original expiry (a failed job never extends validity).
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
    // Fallback for jobs created before grant tracking: flat refund.
    await addCreditsTx(tx, userId, "REFUND", amount, refType, refId, note);
    return;
  }
  for (const c of consumption) {
    await tx.creditGrant.update({
      where: { id: c.grantId },
      data: { remaining: { increment: c.amount } },
    });
  }
  await addCreditsTx(tx, userId, "REFUND", amount, refType, refId, note);
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
    await tx.checkin.create({ data: { userId, date, credits: 2 } });
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
    const order = await client.order.findUnique({ where: { id: orderId } });
    if (!order) throw new Error("order-not-found");
    if (order.status === "paid") return { alreadyPaid: true };
    await client.order.update({
      where: { id: orderId },
      data: { status: "paid", paidAt: new Date() },
    });
    if (kind === "plan" && planId) {
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
        unused = Math.max(0, usage.granted - usage.spentNet);
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
// spent (a refund can't undo usage). The invariant
// User.credits == SUM(CreditGrant.remaining) guarantees the balance can cover it.
export async function revokeOrderCreditsTx(
  tx: Prisma.TransactionClient,
  order: { id: string; userId: string },
): Promise<number> {
  const grants = await tx.creditGrant.findMany({
    where: { refId: order.id, remaining: { gt: 0 } },
    select: { id: true, remaining: true },
  });
  if (grants.length === 0) return 0;
  const revoked = grants.reduce((acc, g) => acc + g.remaining, 0);
  await tx.creditGrant.updateMany({
    where: { id: { in: grants.map((g) => g.id) } },
    data: { remaining: 0 },
  });
  await addCreditsTx(tx, order.userId, "REVOKE", -revoked, "order", order.id, "credits revoked on payment refund");
  return revoked;
}

// Admin compensation: grant non-expiring credits (consumed first like free
// credits) with an ADMIN ledger entry.
export async function adminGrantTx(
  tx: Prisma.TransactionClient,
  userId: string,
  amount: number,
  note: string,
): Promise<void> {
  if (amount <= 0) throw new Error("invalid-amount");
  await grantCreditsTx(tx, userId, "ADMIN", amount, null, "admin", null, note);
}

// Admin clawback: remove credits FIFO (free/admin grants first, then by
// earliest expiry). Preserves the invariant User.credits == SUM(remaining).
export async function adminClawbackTx(
  tx: Prisma.TransactionClient,
  userId: string,
  amount: number,
  note: string,
): Promise<void> {
  if (amount <= 0) throw new Error("invalid-amount");
  const rows = await tx.$queryRaw<Array<{ id: string; remaining: number }>>(
    Prisma.sql`SELECT id, remaining FROM "CreditGrant"
      WHERE "userId" = ${userId} AND remaining > 0
      ORDER BY CASE WHEN source IN ('SIGNUP_BONUS', 'CHECKIN', 'ADMIN') THEN 0 ELSE 1 END,
               "expiresAt" ASC NULLS LAST, "createdAt" ASC
      FOR UPDATE`,
  );
  let needed = amount;
  for (const r of rows) {
    if (needed <= 0) break;
    const take = Math.min(r.remaining, needed);
    await tx.creditGrant.update({
      where: { id: r.id },
      data: { remaining: { decrement: take } },
    });
    needed -= take;
  }
  if (needed > 0) throw new Error("insufficient-credits");
  await addCreditsTx(tx, userId, "ADMIN", -amount, "admin", null, note);
}
