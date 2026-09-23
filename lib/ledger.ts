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
// How long past its own deadline a credit whose funding grant expired while the
// job was in flight stays spendable. It is a GRACE on the deadline that was
// crossed, not a fresh lease: the replacement expires at
// (crossed deadline + this), so a refund can only ever extend a credit's life
// ONCE, and a second crossing of a replacement's own deadline ends it. See
// refundCreditsTx.
export const REFUND_REPLACEMENT_GRACE_MS = 24 * 60 * 60 * 1000;

export interface CycleUsage {
  granted: number;
  spentNet: number;
  revoked: number;
  // The order that funded the measured cycle, so the 30% carryover it produces
  // can be stamped with — and therefore revoked with — that order rather than
  // with the incoming one. See fulfillOrder.
  fundingRefId: string | null;
  // When the measured cycle's own quota ran out. fulfillOrder uses it to decide
  // whether a cycle has actually ended, because planRenewsAt is NOT durable
  // evidence: the daily downgrade sweep (rollover.ts) nulls it, so a renewal
  // that lands more than one sweep after the cycle end had no anchor left to
  // measure and the advertised carryover silently became 0. The SUBSCRIPTION
  // grant carries the same instant and survives the sweep (it is zeroed, not
  // deleted).
  fundingExpiresAt: Date | null;
}

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

// One subscription month from `base`, clamped to the target month's last day.
//
// `setMonth(getMonth() + 1)` rolls overflow forward: 2026-01-31 became
// 2026-03-03 (three free days of plan AND of quota, since the SUBSCRIPTION
// grant is stamped with the same expiry) and 2026-03-31 became 2026-05-01. The
// gift repeated every month the anchor landed on a 29th-31st, and it also
// drifted the anchor, so a customer billed on the 31st was renewing on the 3rd
// within a couple of cycles. Clamping keeps the anchor: Jan 31 → Feb 28/29 →
// Mar 28, which is what a monthly subscription means.
export function addBillingMonth(base: Date): Date {
  const day = base.getDate();
  const renew = new Date(base);
  // Move the month while parked on the 1st, so the intermediate state cannot
  // roll over either.
  renew.setDate(1);
  renew.setMonth(renew.getMonth() + 1);
  // Day 0 of the next month is the last day of the target month.
  const lastDay = new Date(renew.getFullYear(), renew.getMonth() + 1, 0).getDate();
  renew.setDate(Math.min(day, lastDay));
  return renew;
}

// Canonical grant-lock order. EVERY statement that locks CreditGrant rows must
// acquire them in this sequence: two transactions locking the same rows in
// opposite orders deadlock, and Postgres resolves that by aborting one (a 500
// on a webhook or an admin action). It matches the FIFO spend order — free
// sources (SIGNUP_BONUS/CHECKIN) first, then earliest expiry — so
// spendCreditsTx can take the rows in the order they come back; ADMIN is
// deliberately NOT in the free class here, so admin compensation is consumed
// last like any other paid credit. The trailing id is what makes this a TOTAL
// order: fulfillOrder mints a SUBSCRIPTION and a ROLLOVER grant in one
// transaction with the same expiresAt and the same (millisecond) createdAt, and
// on a full tie the ordering was left to the planner — two statements could
// then lock the same pair in opposite orders and deadlock.
const GRANT_LOCK_ORDER = Prisma.sql`ORDER BY CASE WHEN source IN ('SIGNUP_BONUS', 'CHECKIN') THEN 0 ELSE 1 END,
               "expiresAt" ASC NULLS LAST, "createdAt" ASC, "id" ASC`;
export { GRANT_LOCK_ORDER };

// Credits granted, pre-authed and refunded inside one billing cycle, used to
// compute unused quota for the 30% carryover at renewal time.
//
// The cycle's quota is identified by its SUBSCRIPTION GRANT — the newest one
// whose own cycle has ended — NOT by summing SUBSCRIPTION ledger rows in an
// `[anchor - 1 month, now]` window. The window silently dropped the quota of
// any cycle funded by an EARLY renewal: that grant is created before the window
// opens, so `granted` came out 0, `unused` was 0, and the 30% carryover the
// customer was promised never materialised (while the leftover quota was still
// swept at the cycle end). Anchoring on the grant also keeps the cash-out
// protection: it survives planRenewsAt being moved, and its `createdAt` bounds
// the spend scan.
export async function cycleUsageTx(
  tx: Prisma.TransactionClient,
  userId: string,
  // The caller's own witness of the cycle end (planRenewsAt). Used only as a
  // FALLBACK: the primary evidence is the funding grant's own expiry. Kept in
  // the signature because it is what an operator correction — or a test — moves
  // when the plan clock and the grant clock disagree.
  cycleAnchor: Date,
): Promise<CycleUsage> {
  const grantSelect = { id: true, amount: true, refId: true, createdAt: true, expiresAt: true } as const;
  // The quota whose unused portion is being measured is the newest SUBSCRIPTION
  // grant whose OWN cycle has already ended. Two reasons it must be "ended"
  // rather than simply "newest":
  //
  //  - An early renewal (buying the next month before the current one runs out,
  //    which is what a customer does to avoid being cut off) has already minted
  //    the incoming cycle's grant by the time the NEXT renewal arrives. The
  //    newest grant is then the cycle still in play — measuring it reports
  //    nothing unspent for a cycle that has not finished — while the cycle that
  //    actually ended is the one before it. The carryover was therefore granted
  //    only to customers who let their plan lapse and renew afterwards, i.e.
  //    exactly not the population the feature is advertised to (see
  //    PRODUCT_OUTLINE.md: "use 1500 of 2000, 150 lands next month").
  //  - Its expiresAt is the cycle boundary itself: fulfillOrder stamps
  //    SUBSCRIPTION grants with `renew`, and it survives the daily downgrade
  //    sweep, which only nulls User.planRenewsAt.
  //
  // `cycleAnchor` covers the case where the plan clock moved but the grant did
  // not (a correction, or a test rewinding planRenewsAt to model a lapsed
  // cycle) — without it that state would measure as "no cycle at all" and the
  // callers that rely on it would silently stop granting carryover.
  const ended = await tx.creditGrant.findFirst({
    where: { userId, source: "SUBSCRIPTION", expiresAt: { lte: new Date() } },
    orderBy: { createdAt: "desc" },
    select: grantSelect,
  });
  const funding =
    ended ??
    (cycleAnchor.getTime() <= Date.now()
      ? await tx.creditGrant.findFirst({
          where: { userId, source: "SUBSCRIPTION" },
          orderBy: { createdAt: "desc" },
          select: grantSelect,
        })
      : null);
  const cycleOrderIds = new Set(funding?.refId ? [funding.refId] : []);
  const granted = funding?.amount ?? 0;

  // Spend is attributed to the GRANT THAT FUNDED IT, not to a window of the
  // ledger clock. The window was a time slice, so it was wrong in both
  // directions at once: pack spend made in the lapse gap (after the cycle
  // ended, before the renewal) counted as this cycle's quota spend and wiped a
  // carryover the customer had earned, while any spend made more than a month
  // before the anchor — the normal case for a cycle funded by an EARLY renewal,
  // which lasts longer than a month — was invisible and inflated it.
  // Job.consumption records exactly which grants each pre-auth drew from, so
  // the cycle's spend is the set of jobs that drew from the funding grant, net
  // of whatever was refunded to them (a refund may legitimately land after the
  // anchor: a video job can fail up to its 30-minute hard timeout later).
  // A job that drew from several grants counts in full — the only way to
  // straddle the quota's exhaustion point is the single job that exhausts it,
  // and erring there is in the house's favour by at most one job.
  let preAuth = 0;
  let refund = 0;
  if (funding) {
    // Only a lower time bound: a job cannot draw on a grant that did not exist
    // yet, and it keeps the scan small. There is deliberately NO upper bound on
    // the anchor — a job created after the anchor can only have drawn on this
    // grant if the anchor was moved backwards after the fact (the expiry tests
    // do exactly that to simulate a lapsed cycle, and an operator correction
    // looks the same), and in that case the spend is still this cycle's spend.
    const jobs = await tx.job.findMany({
      where: { userId, createdAt: { gte: funding.createdAt } },
      select: { id: true, consumption: true },
    });
    const jobIds = jobs.filter((j) => consumesGrant(j.consumption, funding.id)).map((j) => j.id);
    if (jobIds.length) {
      const spent = await tx.ledgerEntry.findMany({
        where: { userId, refId: { in: jobIds }, type: { in: ["PRE_AUTH", "REFUND"] } },
        select: { type: true, creditsDelta: true, createdAt: true },
      });
      for (const e of spent) {
        // Clawed-back (REVOKE) quota is gone: counting only PRE_AUTH/REFUND
        // treated a fully refunded cycle as "granted and unused", so the next
        // purchase collected 30% carryover on credits the user had already been
        // refunded for — repeatable every cycle. EXPIRE is deliberately NOT
        // counted: that is bookkeeping for credits whose validity already ended
        // at the cycle boundary, and including it made the carryover depend on
        // whether the expiry sweep happened to run before the renewal.
        //
        // A refund nets this cycle's spend only when it landed INSIDE the
        // cycle. A refund that arrives after the deadline did not put the credits
        // back into the measured quota — by then the quota was over, so
        // refundCreditsTx either re-minted the value as a grant whose life starts
        // at the crossed deadline (kept outside this cycle's accounting) or
        // destroyed it — yet netting it cancelled the spend anyway. The user then
        // held the refunded credits AND collected 30% carryover on quota they had
        // been refunded for: up to the full carryover amount per cycle, on top of
        // the credits, repeatable every cycle by draining the quota into jobs
        // just before the boundary and letting them fail just after it.
        if (e.type === "PRE_AUTH") preAuth += Math.abs(e.creditsDelta);
        else if (!funding.expiresAt || e.createdAt.getTime() <= funding.expiresAt.getTime()) {
          refund += e.creditsDelta;
        }
      }
    }
  }
  // Only clawbacks of THIS cycle's own plan quota may reduce its unused quota.
  // A previous version summed every REVOKE and EXPIRE in the window, so a
  // refunded credit PACK (~6000 credits) silently ate the whole carryover, and
  // an unrelated EXPIRE (the previous cycle's rollover grant, which is never
  // counted in `granted`) did the same — both in the customer's disfavour.
  // Scoping to the order that actually funded this cycle's quota keeps the
  // refunded-plan protection while dropping the collateral damage.
  //
  // The REVOKE rows are NOT a sufficient witness for "this cycle was clawed
  // back": revokeOrderCreditsTx only writes one when a spendable remainder was
  // still there to take, and the daily expiry sweep zeroes the remainder
  // (remaining: 0) while leaving `amount` untouched. A subscription refunded
  // after its cycle lapsed — the natural shape of "refund the month I forgot
  // to cancel" — therefore recorded NO REVOKE row at all, and this measurement
  // read the swept remainder as untouched, unspent quota: the next purchase
  // paid out 30% carryover on a cycle the merchant was never paid for, every
  // cycle. Read the funding order's status instead, which is the durable fact.
  let revoked = 0;
  const fundingOrder = funding?.refId
    ? await tx.order.findUnique({ where: { id: funding.refId }, select: { status: true } })
    : null;
  if (fundingOrder?.status === "refunded") {
    revoked = granted;
  } else if (cycleOrderIds.size) {
    const revokedRows = await tx.ledgerEntry.findMany({
      where: { userId, type: "REVOKE", refId: { in: [...cycleOrderIds] } },
      select: { creditsDelta: true },
    });
    for (const e of revokedRows) revoked += Math.abs(e.creditsDelta);
  }
  return {
    granted,
    spentNet: Math.max(0, preAuth - refund),
    revoked,
    fundingRefId: funding?.refId ?? null,
    fundingExpiresAt: funding?.expiresAt ?? null,
  };
}

// Did a job's pre-auth draw from this specific grant?
function consumesGrant(consumption: unknown, grantId: string): boolean {
  if (!Array.isArray(consumption)) return false;
  return consumption.some(
    (c) => typeof c === "object" && c !== null && (c as SpendConsumption).grantId === grantId,
  );
}

// `cycleAnchor` is the cycle end (planRenewsAt), not its start — see
// cycleUsageTx for why the funding grant, not a time window, defines the quota.
export async function cycleUsage(userId: string, cycleAnchor: Date): Promise<CycleUsage> {
  return cycleUsageTx(prisma, userId, cycleAnchor);
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
// The expired portion lands in a REFUND grant that carries the crossed
// deadline plus a grace (see REFUND_REPLACEMENT_GRACE_MS), preserving
// User.credits == SUM(CreditGrant.remaining).
//
// A grant funded by an order that has since been REFUNDED is never restored:
// its credits were already clawed back (or are about to be), so restoring them
// here would leave the customer with both the money and the credits. The
// window is real — a job holds its credits as remaining=0 for as long as it is
// queued/running (up to the video hard timeout), so revokeOrderCreditsTx finds
// nothing to revoke and the later failure refund used to hand it all back.
// The replacement grant minted for the expired portion inherits the ref of the
// grant it replaces, so that protection survives the sweep too (see below).
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
    // It must still mint a GRANT rather than only increment the balance: every
    // other credit source in the app is a grant, spendCreditsTx draws only on
    // grants, and adminClawbackTx reconciles against them — so a bare increment
    // left the user with a balance /api/me displayed and no code could spend
    // (insufficient-credits), while an operator clawback of it threw the same
    // error and runExpiry could never sweep it. Unreachable for jobs created
    // since the credit_grants migration (every creation path writes
    // consumption), so this is a latent landmine, not a live path.
    await grantCreditsTx(tx, userId, "REFUND", amount, null, refType, refId, note);
    return;
  }
  // Lock the consumed rows so the expiry sweep serializes with this refund:
  // if the sweep locks first it zeroes the row and the expiry check below
  // (re-read after the lock) routes that portion into the replacement grant.
  // The ORDER BY matches spendCreditsTx so two spends/refunds over the same
  // rows always take the grant locks in the same sequence.
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      expiresAt: Date | null;
      refType: string | null;
      refId: string | null;
      source: string;
    }>
  >(
    Prisma.sql`SELECT id, "expiresAt", "refType", "refId", source FROM "CreditGrant"
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
  // The expired/vanished portion is replaced by a fresh grant, and it must
  // carry the PROVENANCE OF THE GRANT IT REPLACES rather than the
  // job's own ref. Stamping it with the job (refType "job", refId jobId) made
  // the replacement invisible to revokeOrderCreditsTx, which matches on
  // refId = order.id: credits from a failed job whose funding grant expired
  // while the job sat in retries became permanently order-detached, so a later
  // chargeback on the order that funded them found nothing to take — money
  // refunded, credits kept. One grant per distinct source ref keeps the amount
  // attributable: a job that straddled two orders' credits must not collapse
  // them into a single lump that only one of the refunds can reach.
  //
  // The replacement is bounded, not permanent — and "bounded" has to mean
  // bounded FROM THE DEADLINE, not from now. `expiresAt: null` was the first
  // fix for the sweep swallowing the refund, and it opened the mirror image:
  // the spend path is FIFO by expiry, so submitting jobs seconds before a known
  // expiry (a pack's 12-month date, a cycle end) withholds credits that would
  // otherwise be destroyed, and the failed job's refund converts them into
  // credits the sweep can never touch. Anchoring the replacement at
  // `now + TTL` only slowed that loop down: the replacement is an ordinary
  // spendable grant, so it can be drained and re-minted the same way, one fresh
  // TTL per cycle through it — the balance never expires and one failing job
  // per week buys it forever (a subscription's cycle-bounded quota included,
  // which is what makes the plan recurring).
  //
  // The refund can only be late by as much as a job can outlive its own
  // pre-auth — bounded by retries and the 30-minute video hard timeout — so
  // the honest extension is a grace on the deadline that was crossed:
  // `deadline + REFUND_REPLACEMENT_GRACE_MS`. A late refund therefore returns
  // credits with the life they would have had, not a new lease, and the farm
  // stops at one iteration. Two conditions end a lineage for good:
  //   - the portion is granted but the grace is over (the job failed long
  //     after its deadline — the sweep would have destroyed these anyway), and
  //   - the grant being replaced is itself a REFUND replacement: its life was
  //     already one grace period, and a grace is not renewable.
  const expiredByRef = new Map<
    string,
    { refType: string | null; refId: string | null; amount: number; expiresAt: Date }
  >();
  // Portions that are NOT given back: clawed back by a refunded order, or
  // lapsed past their grace. Both are deducted from the REFUND ledger entry,
  // because the balance must not move for credits the user does not receive.
  let notRestored = 0;
  for (const c of consumption) {
    const row = rows.find((r) => r.id === c.grantId);
    // A vanished grant has no provenance left to inherit — fall back to the
    // caller's ref (the job), which is all that is known.
    const ref = row
      ? { refType: row.refType ?? null, refId: row.refId ?? null }
      : { refType: refType ?? null, refId: refId ?? null };
    if (row && row.refType === "order" && row.refId && refundedOrders.has(row.refId)) {
      notRestored += c.amount;
      continue;
    }
    if (!row || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) {
      if (row && row.source === "REFUND") {
        // The grace was already spent on this lineage. Restoring here would
        // hand back credits whose deadline has now passed twice over, and the
        // second replacement could be crossed and refunded again — the farm.
        notRestored += c.amount;
        continue;
      }
      const deadline = row?.expiresAt ?? null;
      const expiresAt = new Date(
        (deadline ?? new Date()).getTime() + REFUND_REPLACEMENT_GRACE_MS,
      );
      if (expiresAt.getTime() <= Date.now()) {
        // Late beyond the grace: the credits' life ended at their deadline and
        // the sweep would have destroyed them; a refund this late cannot revive
        // them without making the deadline farmable. Worth a line in the log —
        // a job can only outlive its pre-auth by ~30 minutes, so reaching here
        // means the delivery path was down for a day (the operator's problem,
        // not the customer's) and a refund just silently shrank.
        console.warn(
          `[ledger] refund arrived past the grace window for ${c.amount} credit(s) whose grant expired at ${deadline?.toISOString() ?? "unknown"} — not restored (user ${userId})`,
        );
        notRestored += c.amount;
        continue;
      }
      // Keyed by provenance AND by the deadline that was crossed: one ref can
      // cover grants with different deadlines (a job that drew on both a
      // replacement and the pack grant behind it), and collapsing them would
      // give the earlier one the later one's life.
      const key = `${ref.refType ?? ""}|${ref.refId ?? ""}|${deadline?.getTime() ?? "none"}`;
      const bucket = expiredByRef.get(key) ?? { ...ref, amount: 0, expiresAt };
      bucket.amount += c.amount;
      expiredByRef.set(key, bucket);
      continue;
    }
    await tx.creditGrant.update({
      where: { id: c.grantId },
      data: { remaining: { increment: c.amount } },
    });
  }
  for (const bucket of expiredByRef.values()) {
    await tx.creditGrant.create({
      data: {
        userId,
        source: "REFUND",
        amount: bucket.amount,
        remaining: bucket.amount,
        expiresAt: bucket.expiresAt,
        refType: bucket.refType,
        refId: bucket.refId,
      },
    });
  }
  if (amount - notRestored > 0) {
    await addCreditsTx(tx, userId, "REFUND", amount - notRestored, refType, refId, note);
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
      const renew = addBillingMonth(base);
      // 30% of the unused quota from a just-ended cycle carries into the new
      // one, and only from a cycle that has ACTUALLY ended.
      //
      // "Ended" is decided by the measured cycle's own quota grant, whose
      // expiresAt is the cycle boundary (cycleUsageTx selects the newest grant
      // that has run out). planRenewsAt is consulted only as the fallback
      // witness for when the two clocks disagree — an operator correction, or a
      // test that rewinds the plan alone.
      //
      // Gating on planRenewsAt instead was the last piece of why the advertised
      // rollover did not exist in practice. A customer who renews inside their
      // cycle — the ordinary way to avoid being cut off — always has a
      // planRenewsAt in the FUTURE at renewal time (it is the cycle they are
      // extending) and an unexpired current grant, so both readings said "not
      // ended", `unused` came out 0, and the leftover was still swept at the
      // boundary. The carryover was paid exclusively to customers who let the
      // plan lapse first. Everything below therefore measures the previous,
      // finished cycle while the customer is still inside the current one; the
      // newly bought month is untouched by it.
      let rollover = 0;
      let unused = 0;
      let rolloverRef: string = orderId;
      const usage = await cycleUsageTx(client, userId, user.planRenewsAt ?? now);
      const planClockSaysEnded = user.planRenewsAt !== null && user.planRenewsAt <= now;
      const grantClockSaysEnded = usage.fundingExpiresAt !== null && usage.fundingExpiresAt <= now;
      if (grantClockSaysEnded || (planClockSaysEnded && usage.granted > 0)) {
        unused = Math.max(0, usage.granted - usage.spentNet - usage.revoked);
        rollover = Math.floor(unused * ROLLOVER_RATE);
        // Stamp the carryover with the order that funded the MEASURED cycle,
        // not with the incoming one. The carryover is a benefit derived from
        // that cycle's unspent quota, and refunding that order must take it
        // back with the rest (revokeOrderCreditsTx matches on refId): stamped
        // with the new order it was invisible to the refund of the old one, so
        // a customer could renew, claim month 1 back and keep 30% of month 1's
        // quota — every cycle. Falls back to the incoming order when the old
        // cycle has no funding order to name (legacy/manual grants).
        if (usage.fundingRefId) rolloverRef = usage.fundingRefId;
        // A cycle carries over once. Measuring "the newest grant that has
        // ended" means a second renewal before ANY later cycle ends would
        // measure the same cycle again and pay its 30% twice — each time for a
        // real payment, so it is a bounded over-delivery rather than a mint,
        // but the carryover is a property of the cycle, not of the purchase.
        // The witness is the ROLLOVER grant already stamped with that cycle's
        // funding order: the same provenance the refund clawback depends on.
        if (rollover > 0 && usage.fundingRefId) {
          const alreadyPaid = await client.creditGrant.count({
            where: { userId, source: "ROLLOVER", refId: usage.fundingRefId },
          });
          if (alreadyPaid > 0) rollover = 0;
        }
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
          rolloverRef,
          `30% of ${unused} unused quota${rolloverRef === orderId ? "" : " (previous cycle)"}`,
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
      WHERE "refId" = ${order.id} AND "refType" = 'order'
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

// Revoke the PAID TIER itself when a plan order is refunded or charged back.
// revokeOrderCreditsTx only takes the credits back: User.plan/planRenewsAt are
// written in exactly two places (the grant here and the expiry sweep in
// rollover.ts), so a refunded subscription kept its paid entitlement for the
// rest of the cycle — unwatermarked output, paid-plan UI, zero cost — and
// because a purchase before the cycle end extends planRenewsAt by another
// month, each new order pushed the lapse date out again: a chargeback loop
// bought the paid tier permanently for the price of the dispute fee.
//
// Guarded so refunding an OLD, superseded plan order cannot clobber a newer
// paid one: the downgrade only applies when this order is the one funding the
// CURRENT cycle, which is the SUBSCRIPTION grant it minted expiring exactly at
// the plan's own renewal anchor. updateMany re-evaluates that predicate after
// any lock wait, so a renewal committing concurrently either wins (anchor
// moved → no downgrade) or loses (anchor still ours → we downgrade and the
// renewal then starts a fresh cycle).
export async function revokePlanEntitlementTx(
  tx: Prisma.TransactionClient,
  order: { id: string; userId: string; kind: string; planId: string | null },
): Promise<boolean> {
  if (order.kind !== "plan" || !order.planId) return false;
  const funding = await tx.creditGrant.findFirst({
    where: { userId: order.userId, refType: "order", refId: order.id, source: "SUBSCRIPTION" },
    select: { expiresAt: true },
  });
  if (!funding?.expiresAt) return false;
  // Downgrade to the newest cycle that is STILL PAID FOR and still running,
  // not blindly to free. Buying month 2 before month 1 ends extends
  // planRenewsAt to the end of month 2, so month 2's order is the funding order
  // of the current cycle and refunding it matched the guard below — dropping a
  // customer who had paid for month 1 to `free` on day 5 of that month, losing
  // the tier (unwatermarked output, paid UI) for time they paid for. The
  // refunded order's own grant is excluded automatically: the webhook flips it
  // to "refunded" before calling this.
  const candidates = await tx.creditGrant.findMany({
    where: {
      userId: order.userId,
      source: "SUBSCRIPTION",
      refType: "order",
      refId: { not: null },
      expiresAt: { gt: new Date() },
    },
    orderBy: { expiresAt: "desc" },
    select: { refId: true, expiresAt: true },
  });
  const paid = candidates.length
    ? await tx.order.findMany({
        where: {
          id: { in: candidates.map((c) => c.refId as string) },
          userId: order.userId,
          status: "paid",
          kind: "plan",
        },
        select: { id: true, planId: true },
      })
    : [];
  const paidById = new Map(paid.map((o) => [o.id, o]));
  let fallback: { plan: string; expiresAt: Date } | null = null;
  for (const c of candidates) {
    const o = c.refId ? paidById.get(c.refId) : undefined;
    if (o?.planId && c.expiresAt) {
      fallback = { plan: o.planId, expiresAt: c.expiresAt };
      break;
    }
  }
  const res = await tx.user.updateMany({
    where: {
      id: order.userId,
      plan: order.planId,
      planRenewsAt: funding.expiresAt,
    },
    data: fallback
      ? { plan: fallback.plan, planRenewsAt: fallback.expiresAt }
      : { plan: "free", planRenewsAt: null },
  });
  return res.count === 1;
}

// Admin compensation: grant non-expiring credits with an ADMIN ledger entry
// attributed to the acting admin. Spent LAST, not first — only SIGNUP_BONUS and
// CHECKIN are in the free class of GRANT_LOCK_ORDER, and "never expires" is the
// attribute that matters here (compensation cannot lapse). The comment used to
// claim "consumed first like free credits", which is the opposite of what the
// order does; an operator reading it would believe compensation credits are
// protected from being spent behind expiring ones.
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
