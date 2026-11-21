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
  // Who caused the movement when that is not the row's user (see
  // LedgerEntry.actorId): the operator behind an ADJUST grant or clawback.
  actorId?: string | null,
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
    data: { userId, type, creditsDelta: delta, balanceAfter, refType, refId, note, actorId },
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
  cycleOrderId?: string | null,
) {
  if (amount <= 0) return;
  await tx.creditGrant.create({
    data: { userId, source, amount, remaining: amount, expiresAt, refType, refId, cycleOrderId },
  });
  await addCreditsTx(tx, userId, source, amount, refType, refId, note);
}

// Resolve the order whose CYCLE each ROLLOVER grant was spent in.
//
// A carryover carries two provenances: refId names the cycle it was MEASURED
// from (refunding that cycle must take it back), and the renewal order names
// the cycle it is spent in (refunding the renewal must take it back too).
// `cycleOrderId` stores the second. Rows written before that column existed
// are resolved by the shared deadline: fulfillOrder creates the SUBSCRIPTION
// grant and the ROLLOVER in one transaction with the same `renew`, so
// (userId, expiresAt) identifies the renewal order exactly.
//
// Returns grantId → renewal order id for grants this function can resolve.
export async function resolveRolloverCycleOrders(
  tx: Prisma.TransactionClient,
  userId: string,
  grants: Array<{
    id: string;
    source: string;
    expiresAt: Date | null;
    cycleOrderId?: string | null;
  }>,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const legacyExpiries: Date[] = [];
  for (const g of grants) {
    if (g.source !== "ROLLOVER") continue;
    if (g.cycleOrderId) resolved.set(g.id, g.cycleOrderId);
    else if (g.expiresAt) legacyExpiries.push(g.expiresAt);
  }
  if (legacyExpiries.length === 0) return resolved;
  const subscriptions = await tx.creditGrant.findMany({
    where: {
      userId,
      source: "SUBSCRIPTION",
      refType: "order",
      refId: { not: null },
      expiresAt: { in: legacyExpiries },
    },
    select: { refId: true, expiresAt: true },
  });
  const byExpiry = new Map<number, string>();
  for (const s of subscriptions) {
    if (s.refId && s.expiresAt) byExpiry.set(s.expiresAt.getTime(), s.refId);
  }
  for (const g of grants) {
    if (g.source !== "ROLLOVER" || g.cycleOrderId || !g.expiresAt) continue;
    const cycle = byExpiry.get(g.expiresAt.getTime());
    if (cycle) resolved.set(g.id, cycle);
  }
  return resolved;
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
//
// The arithmetic runs on the UTC fields (pass 30): getDate/setMonth/getFullYear
// read the process's LOCAL calendar, so the same build against the same
// database produced a different renewal instant per host TZ — an anchor at
// 2026-04-30T20:00Z renewed 2026-05-30 under the UTC containers and 2026-05-31
// on a +08 dev/operator box (probed), a day of paid tier and of quota validity
// that differs between two deploys of one build. The instant is compared
// against now() in SQL and stored as UTC, so the UTC calendar is the one it
// belongs to.
export function addBillingMonth(base: Date): Date {
  const day = base.getUTCDate();
  const renew = new Date(base);
  // Move the month while parked on the 1st, so the intermediate state cannot
  // roll over either.
  renew.setUTCDate(1);
  renew.setUTCMonth(renew.getUTCMonth() + 1);
  // Day 0 of the next month is the last day of the target month.
  const lastDay = new Date(Date.UTC(renew.getUTCFullYear(), renew.getUTCMonth() + 1, 0)).getUTCDate();
  renew.setUTCDate(Math.min(day, lastDay));
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
//
// ROLLOVER before SUBSCRIPTION when the expiry TIES (pass 66). The two grants
// minted by a renewal share expiresAt and createdAt, so the old tiebreak was
// `id` — an opaque cuid whose order depends on generation, not on meaning. It
// decided WHICH LOT got spent: drawing the SUBSCRIPTION quota first left the
// carryover untouched to expire (spentNet = full quota, unused = 0, no next
// carryover), while drawing the carryover first preserved quota and paid 30%
// of it next cycle. Same customer behaviour, different money, chosen by a
// random id. The carryover is the lot that cannot be carried again, so it is
// spent first — the standard non-renewable-first rule, and the direction that
// matches PRODUCT_OUTLINE's "use 1500 of 2000, 150 lands next month". The rank
// sits AFTER expiresAt, so an earlier deadline still wins; `id` remains as the
// final total-order tiebreak.
const GRANT_LOCK_ORDER = Prisma.sql`ORDER BY CASE WHEN source IN ('SIGNUP_BONUS', 'CHECKIN') THEN 0 ELSE 1 END,
               "expiresAt" ASC NULLS LAST,
               CASE WHEN source = 'ROLLOVER' THEN 0 WHEN source = 'SUBSCRIPTION' THEN 1 ELSE 2 END,
               "createdAt" ASC, "id" ASC`;
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
/**
 * The DATABASE's clock, as a JS Date.
 *
 * Every money decision has to be made on one clock, and it is the one the rows
 * live in: spending (`spendCreditsTx`), the sweep (`lib/expiry.ts`) and the
 * refund's deadline (pass 19) all compare against `now()` inside SQL. The
 * plan/cycle boundary was the last family still on `new Date()` — the app's
 * clock. Where the two differ (the app in one container and Postgres elsewhere,
 * or NTP correcting either after a host sleep), a cycle the database still
 * considers live measured as ended and minted its 30% carryover on top of quota
 * that was still spendable; the mirror direction silently destroyed one; and the
 * renewal anchor moved by the skew, so an early renewal could drop paid days.
 *
 * Inside a transaction `now()` is that transaction's start time, so every
 * comparison in that transaction — and the deadline it mints — agrees.
 */
export async function dbNow(client: Prisma.TransactionClient | typeof prisma): Promise<Date> {
  const [row] = await client.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT now() AS now`);
  return row.now;
}

export async function cycleUsageTx(
  tx: Prisma.TransactionClient,
  userId: string,
  // The caller's own witness of the cycle end (planRenewsAt). Used only as a
  // FALLBACK: the primary evidence is the funding grant's own expiry. Kept in
  // the signature because it is what an operator correction — or a test — moves
  // when the plan clock and the grant clock disagree.
  cycleAnchor: Date,
): Promise<CycleUsage> {
  // Which cycle counts as "ended" is a money decision, so it is made on the
  // DATABASE's clock — the one the grant rows and the spend scan use. On
  // `new Date()` a skew made a cycle the database still considers live measure
  // as ended, and its 30% carryover was minted on top of quota that was still
  // spendable. Inside a transaction `now()` is that transaction's start time, so
  // every comparison below agrees with the reads that follow.
  const now = await dbNow(tx);
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
    where: { userId, source: "SUBSCRIPTION", expiresAt: { lte: now } },
    // Order by the CYCLE BOUNDARY, not by createdAt (pass 39). createdAt is
    // DEFAULT CURRENT_TIMESTAMP — the writing transaction's BEGIN time, which
    // for two nearly simultaneous fulfillments can be in the opposite order to
    // their commit/cycle order. Picking the older cycle as "the one that just
    // ended" measures the wrong quota (and the rollover witness then suppresses
    // the real cycle's carryover). expiresAt IS the cycle and is monotone for
    // sequential/early renewals; id is the total-order tiebreak.
    orderBy: [{ expiresAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
    select: grantSelect,
  });
  const funding =
    ended ??
    (cycleAnchor.getTime() <= now.getTime()
      ? await tx.creditGrant.findFirst({
          where: { userId, source: "SUBSCRIPTION" },
          orderBy: [{ expiresAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
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
    //
    // The bound is BACKDATED by the transaction-start allowance (pass 39).
    // Job.createdAt is the job-creation transaction's BEGIN time, and a
    // transaction that began before the renewal can still run its spend AFTER
    // the renewal commits (it waits on the User lock): its spend drew on the
    // new SUBSCRIPTION grant while its createdAt is earlier than the grant's.
    // The old exact bound then filtered that job out, understating the cycle's
    // spend and overpaying carryover. Transactions are bounded by Prisma's 5s
    // interactive budget, so a minute is generous; extra rows are harmless
    // because `consumption` is the authoritative attribution.
    const TX_START_ALLOWANCE_MS = 60_000;
    // Filtered in SQL, not in JS (pass 62). This used to select `consumption`
    // for every job the account created since the grant and filter with
    // consumesGrant in memory: at cycle sizes the surrounding chunking already
    // has to survive (pass 18 measured 33k-100k jobs), that materialises the
    // whole cycle as JS objects inside the payment webhook's interactive
    // transaction — memory and time that can exceed Prisma's 5s budget and
    // make a paid renewal fail permanently (funding.createdAt is fixed, so the
    // window never shrinks). The containment predicate selects exactly the
    // rows `consumesGrant` did: each array element is checked for a matching
    // `grantId`, and non-array/NULL values match nothing.
    const jobRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM "Job"
      WHERE "userId" = ${userId}
        AND "createdAt" >= ${new Date(funding.createdAt.getTime() - TX_START_ALLOWANCE_MS)}
        AND "consumption" @> ${JSON.stringify([{ grantId: funding.id }])}::jsonb
    `);
    const jobIds = jobRows.map((j) => j.id);
    if (jobIds.length) {
      const spent: Array<{ type: string; creditsDelta: number; createdAt: Date }> = [];
      // Chunked, and this is load-bearing rather than tidy: Prisma sends an
      // `in` list as one bind parameter per element and PostgreSQL refuses a
      // prepared statement past 32,767 of them. A plain `refId: { in: … }` scan
      // happens to survive (Prisma splits a lone list itself) but this query
      // also carries `type: { in: […] }`, and the pair defeats that splitting —
      // the whole call throws `too many bind variables`. `fulfillOrder` awaits
      // this inside the payment webhook's transaction, so a heavy account (33k
      // jobs created since its cycle grant; ~1,100/day, well inside what five
      // inflight jobs can push) made its next RENEWAL fail with a 500 that no
      // retry can ever clear: the payment is taken, the credits are not
      // granted, and the provider's retry stream is aimed at the endpoint every
      // customer's payments share.
      for (const part of idChunks(jobIds)) {
        spent.push(
          ...(await tx.ledgerEntry.findMany({
            where: { userId, refId: { in: part }, type: { in: ["PRE_AUTH", "REFUND"] } },
            select: { type: true, creditsDelta: true, createdAt: true },
          })),
        );
      }
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
  //
  // Pass 36 added the other taker to this scan: an operator's clawback of the
  // cycle's quota (adminClawbackTx) writes its own row with the credited
  // order's refType/refId, so it is counted here like a refund revocation —
  // before that, clawed-back quota was invisible to the measurement and its
  // 30% was re-granted at the next renewal (probed). The refType and
  // negative-delta legs keep this scoped to takes: a positive ADMIN grant can
  // never be subtracted from the cycle's quota, and free/admin grants have no
  // order ref at all.
  let revoked = 0;
  const fundingOrder = funding?.refId
    ? await tx.order.findUnique({ where: { id: funding.refId }, select: { status: true } })
    : null;
  if (fundingOrder?.status === "refunded") {
    revoked = granted;
  } else if (cycleOrderIds.size) {
    const revokedRows = await tx.ledgerEntry.findMany({
      where: {
        userId,
        type: { in: ["REVOKE", "ADMIN"] },
        refType: "order",
        creditsDelta: { lt: 0 },
        refId: { in: [...cycleOrderIds] },
      },
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

// PostgreSQL refuses a prepared statement with more than 32,767 bind
// parameters, and Prisma sends one per element of an `in` list. Prisma splits a
// lone list itself, but not when the same statement carries a second one, and
// never for `updateMany` — so every id list that can grow with how much the
// account has been USED goes through here. Both callers below were real
// failures: a 33k-job cycle made a paid renewal 500 forever (ledger), and 33k
// expired grants for one account stalled the expiry sweep for every other
// account (`progressed` stayed false, which breaks the whole batch loop).
export const ID_CHUNK = 5_000;
export function idChunks<T>(items: T[], size = ID_CHUNK): T[][] {
  if (items.length <= size) return items.length ? [items] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Did a job's pre-auth draw from this specific grant?
// Kept (and exported for the test that pins the SQL containment equivalent) so
// the JS definition of "this job drew on this grant" stays visible next to the
// query that now implements it.
export function consumesGrant(consumption: unknown, grantId: string): boolean {
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

// A grant that predates the invariant CHECK (migration
// 20260926120000_credit_grant_invariant_check) may still hold more than it
// granted — `remaining > amount`. The CHECK is NOT VALID, so the existing rows
// were not scanned when it was added, but it IS enforced on every write from
// then on: the next UPDATE of such a row aborts whatever transaction touched it
// (23514). That turns a legacy bookkeeping state into an account that cannot
// spend at all — spendCreditsTx aborts the whole job-creation transaction, so
// every generation 500s while /api/me keeps advertising the balance, and
// adminClawbackTx fails identically, so the operator's natural remedy fails
// too. refundCreditsTx used to drop the refund on the floor for the same reason.
//
// The excess was never backed by a GRANT ledger row (see
// scripts/repair-credit-invariant.ts), so the faithful repair is to write it off
// — the same correction the operator script performs, applied on touch so the
// account keeps working without waiting for an operator. Callers must already
// hold this row's FOR UPDATE lock (taken in GRANT_LOCK_ORDER, which is what
// makes the balance write below safe next to a concurrent grant).
async function writeOffExcessTx(
  tx: Prisma.TransactionClient,
  userId: string,
  grantId: string,
  held: number,
  cap: number,
  target: number,
  reason: string,
): Promise<void> {
  // `held` is the caller's view, used for the early-out and the log. The ROW is
  // re-read before arithmetic: the balance delta below is derived from what the
  // row actually holds, and callers can hold a snapshot rather than the current
  // value (two consumption rows naming one grant — see heldPerGrant in
  // refundCreditsTx). A stale value here would drop User.credits below
  // SUM(remaining) silently: every row-side write stays in the CHECK's range, so
  // nothing fires, and the account answers insufficient-credits to spends it can
  // afford. The FOR UPDATE lock is already held, so the re-read sees this
  // transaction's own earlier writes.
  const fresh = await tx.creditGrant.findUnique({ where: { id: grantId }, select: { remaining: true } });
  const current = fresh?.remaining ?? held;
  // A NEGATIVE `amount` is pre-CHECK corruption, and the CHECK is NOT VALID for
  // rows that predate it: no value of `remaining` satisfies
  // `0 <= remaining <= amount`, so EVERY write to such a row aborts the
  // transaction. The callers pass `cap = row.amount`, which made the
  // write-off's own update (target = -5) the thing that failed — the account
  // could not spend, be clawed back, or receive a failed-job refund, and
  // scripts/repair-credit-invariant.ts computed the same impossible target and
  // aborted its whole run (pass 66). Repair the amount to 0 in the same write:
  // a grant that granted a negative number of credits grants none.
  const repairAmount = cap < 0;
  const safeTarget = Math.max(0, Math.min(target, Math.max(0, cap)));
  if (repairAmount && current < 0) {
    // A negative HOLDING as well as a negative amount cannot be repaired here
    // without either silently minting credits (0 is above −3, and the row is
    // the sum the balance must equal) or writing a value the CHECK rejects.
    // This state is what scripts/repair-credit-invariant.ts is for; it zeroes
    // both sides and recomputes the balance through the ledger.
    throw new Error(
      `negative-grant-row: grant ${grantId} holds ${current} credits against a grant of ${cap} — run scripts/repair-credit-invariant.ts --fix`,
    );
  }
  if (repairAmount && current === 0) {
    // Zero holding, negative amount: no credit moves, only the impossible
    // ceiling. No ledger row is needed because the balance is unchanged.
    await tx.creditGrant.update({ where: { id: grantId }, data: { amount: 0, remaining: 0 } });
    return;
  }
  if (safeTarget >= current) {
    if (repairAmount) {
      await tx.creditGrant.update({ where: { id: grantId }, data: { amount: 0, remaining: current } });
    }
    return;
  }
  // The balance comes down by exactly as much as the row does, or
  // credits == SUM(remaining) breaks in the other direction. Reading the column
  // (instead of assuming it equals the rows' sum) keeps the ledger arithmetic
  // exact even for an account whose balance had ALREADY drifted below its rows:
  // the write-off is capped at what the column holds and the rest of the drift
  // is left for scripts/repair-credit-invariant.ts, which is what reports on it.
  //
  // The read is a snapshot, and the clamp can be stale by the time the
  // increment lands (a concurrent commit lowered the balance — the expiry
  // sweep, a revoke, another repair). Then the clamped delta still overshoots,
  // addCreditsTx refuses the negative outcome, and this whole transaction
  // rolls back — a transient failure the next reap recomputes from the new
  // balance with no state written. Deliberately not "fixed" with a User-row
  // FOR UPDATE here: that would introduce a grant→user lock edge against
  // erasure's user→grants cascade, i.e. a deadlock in exchange for a
  // self-healing retry.
  const user = await tx.user.findUnique({ where: { id: userId }, select: { credits: true } });
  if (!user) throw new Error("user-not-found");
  await tx.creditGrant.update({
    where: { id: grantId },
    // `amount` is repaired in the same statement when it was negative: writing
    // only `remaining` would leave the row violating the CHECK, i.e. it would
    // fail again on the next touch.
    data: repairAmount ? { remaining: safeTarget, amount: 0 } : { remaining: safeTarget },
  });
  // The clamp's sign must come from the write-off, not from a negative
  // balance (pass 63). `Math.max(target - current, -user.credits)` with
  // credits < 0 produced a POSITIVE delta: writeOffExcessTx would then MINT
  // credits while repairing an over-holding grant. addCreditsTx refuses any
  // negative outcome, so no app path can create such a balance — but this is
  // the repair function for a database that already drifted, and "the repair
  // mints credits" is the wrong direction to be wrong in. Floor the balance
  // at zero, exactly like revokeOrderCreditsTx's debit clamp: with a negative
  // balance the delta is 0, addCreditsTx's own balance check then refuses the
  // transaction, and the drift is left to scripts/repair-credit-invariant.ts
  // rather than papered over with new credits.
  const delta = Math.max(safeTarget - current, -Math.max(0, user.credits));
  await addCreditsTx(
    tx,
    userId,
    "ADMIN",
    delta,
    "grant",
    grantId,
    `credit invariant repair on touch: grant ${grantId} held ${current} credits for a grant of ${cap}, and a row above its own amount cannot be written any more (CHECK) — the unbacked excess was written off (${reason})`,
  );
  console.warn(
    `[ledger] wrote off ${current - safeTarget} unbacked credit(s) from grant ${grantId} (held ${current} of ${cap}${repairAmount ? ", negative amount repaired to 0" : ""}) for user ${userId} — ${reason}`,
  );
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
  const rows = await tx.$queryRaw<Array<{ id: string; remaining: number; amount: number }>>(
    Prisma.sql`SELECT id, remaining, amount FROM "CreditGrant"
      WHERE "userId" = ${userId} AND remaining > 0
        AND ("expiresAt" IS NULL OR "expiresAt" > now())
      ${GRANT_LOCK_ORDER}
      FOR UPDATE`,
  );
  let needed = amount;
  const consumption: SpendConsumption[] = [];
  for (const r of rows) {
    if (needed <= 0) break;
    // A row from before the CHECK cannot be decremented below its excess, so
    // repair it first: without this the decrement aborts this whole transaction
    // and the account can never generate again.
    if (r.remaining > r.amount) {
      await writeOffExcessTx(
        tx,
        userId,
        r.id,
        r.remaining,
        r.amount,
        r.amount,
        "repaired while spending from it",
      );
      r.remaining = r.amount;
    }
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
  //
  // Whether a grant is expired is decided by the DATABASE's clock, in this
  // statement — not by `Date.now()` in the application. Spending
  // (spendCreditsTx) and sweeping (lib/expiry.ts) both compare against `now()`,
  // so the app-clock version put one judgement on a different timeline: a grant
  // whose deadline falls inside the app↔database skew was expired for one side
  // and live for the other, and the mismatch was invisible because on a single
  // host the two clocks are the same machine. Where they are not (the app runs
  // in a container, Postgres on another host, NTP correcting either), the
  // refund would either restore credits into a grant the sweep then zeroes out
  // from under it — the user is refunded and the balance still drops — or hand
  // back a grant the spend path already refuses. `now()` is the transaction
  // timestamp, i.e. exactly what the sweep compares against.
  const graceSec = REFUND_REPLACEMENT_GRACE_MS / 1000;
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      expiresAt: Date | null;
      refType: string | null;
      refId: string | null;
      cycleOrderId: string | null;
      source: string;
      amount: number;
      remaining: number;
      expired: boolean;
      graceExpired: boolean;
    }>
  >(
    Prisma.sql`SELECT id, "expiresAt", "refType", "refId", "cycleOrderId", source, amount, remaining,
        ("expiresAt" IS NOT NULL AND "expiresAt" <= now()) AS expired,
        -- A dead grant with no deadline (expiresAt IS NULL) is never past its
        -- grace: the replacement arithmetic falls back to the current time for
        -- that case, i.e. now + grace, which is always in the future.
        ("expiresAt" IS NOT NULL AND "expiresAt" + make_interval(secs => ${graceSec}) <= now()) AS "graceExpired"
      FROM "CreditGrant"
      WHERE id IN (${Prisma.join(consumption.map((c) => c.grantId))})
      ${GRANT_LOCK_ORDER}
      FOR UPDATE`,
  );
  // A carryover belongs to TWO orders: the one it was measured from (refId)
  // and the renewal whose cycle it is spent in (cycleOrderId / the legacy
  // shared-expiry resolution). A refund of either must stop the restore.
  const cycleOrders = await resolveRolloverCycleOrders(tx, userId, rows);
  const orderRefs = [
    ...new Set([
      ...rows.filter((r) => r.refType === "order" && r.refId).map((r) => r.refId as string),
      ...rows.filter((r) => r.cycleOrderId).map((r) => r.cycleOrderId as string),
      ...cycleOrders.values(),
    ]),
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
    {
      refType: string | null;
      refId: string | null;
      cycleOrderId: string | null;
      amount: number;
      expiresAt: Date;
    }
  >();
  // Portions that are NOT given back: clawed back by a refunded order, or
  // lapsed past their grace. Both are deducted from the REFUND ledger entry,
  // because the balance must not move for credits the user does not receive.
  let notRestored = 0;
  // What this call has already given back, per grant. Two consumption rows can
  // name the same grant, and a stale read of `remaining` would let the second
  // increment cross `amount` even though the first one was checked.
  const restoredPerGrant = new Map<string, number>();
  // What this call has left the row HOLDING, per grant. `rows` is the FOR
  // UPDATE snapshot from the top of the transaction; a second consumption row
  // for the same grant judged against that snapshot would both mis-decide (a
  // row that held > amount at lock time reads over-cap even after the first
  // iteration already brought it back to `amount`) and mis-arithmetic — the
  // write-off's balance delta is derived from the value it is handed, and a
  // stale one drops User.credits below SUM(remaining). That drift is silent:
  // every row-side write stays in range so the CHECK never fires, and the
  // account simply answers insufficient-credits to spends it can afford, until
  // scripts/repair-credit-invariant.ts runs.
  const heldPerGrant = new Map<string, number>();
  for (const c of consumption) {
    const row = rows.find((r) => r.id === c.grantId);
    // A vanished grant has no provenance left to inherit — fall back to the
    // caller's ref (the job), which is all that is known.
    const cycleOrderId = row ? (row.cycleOrderId ?? cycleOrders.get(row.id) ?? null) : null;
    const ref = row
      ? { refType: row.refType ?? null, refId: row.refId ?? null, cycleOrderId }
      : { refType: refType ?? null, refId: refId ?? null, cycleOrderId: null };
    const fundedByRefundedOrder =
      row !== undefined &&
      ((row.refType === "order" && !!row.refId && refundedOrders.has(row.refId)) ||
        (!!cycleOrderId && refundedOrders.has(cycleOrderId)));
    if (fundedByRefundedOrder) {
      notRestored += c.amount;
      continue;
    }
    // Both conditions come from the statement above (the database's clock).
    if (!row || row.expired) {
      if (row && row.source === "REFUND") {
        // The grace was already spent on this lineage. Restoring here would
        // hand back credits whose deadline has now passed twice over, and the
        // second replacement could be crossed and refunded again — the farm.
        notRestored += c.amount;
        continue;
      }
      const deadline = row?.expiresAt ?? null;
      // The fallback (a grant that vanished with no deadline to inherit) takes
      // the DATABASE clock, like every other money deadline (pass 26/31: the
      // replacement's own expiry is later compared against SQL `now()` by
      // spendCreditsTx, runExpiry and the reminders, so minting it from the
      // app clock handed the host↔database skew to the credits' lifetime).
      const expiresAt = new Date(
        (deadline ?? (await dbNow(tx))).getTime() + REFUND_REPLACEMENT_GRACE_MS,
      );
      if (row?.graceExpired) {
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
      const key = `${ref.refType ?? ""}|${ref.refId ?? ""}|${ref.cycleOrderId ?? ""}|${deadline?.getTime() ?? "none"}`;
      const bucket = expiredByRef.get(key) ?? { ...ref, amount: 0, expiresAt };
      bucket.amount += c.amount;
      expiredByRef.set(key, bucket);
      continue;
    }
    // A grant that cannot hold the increment must not be written anyway: the
    // CHECK from migration 20260926120000_credit_grant_invariant_check enforces
    // `0 <= remaining <= amount` on every write, so crossing `amount` aborts the
    // caller's WHOLE transaction. For a terminal job failure that transaction is
    // the job's CAS to `failed` plus this refund — the rollback left the job
    // `running` with a stale heartbeat, recoverStuckJobs reaped it every ~36s and
    // failed it identically for ever, and the pre-auth was never given back.
    // Two different states reach here, and they are not the same money:
    //
    //  - The row ALREADY holds more than its amount (a legacy row from before
    //    the CHECK). Its excess was never granted, so writing that excess off
    //    frees exactly the room this refund needs without minting anything: the
    //    row ends at `amount` and the customer gets their credits back. Refusing
    //    instead — which is what this branch did — destroyed credits a failing
    //    job owed the customer, for ever, with only a log line.
    //  - The row is legitimately at its cap, which means this consumption was
    //    already refunded (or predates grant tracking). No excess exists to
    //    write off, and minting here would be free credits: keep refusing.
    const cap = row ? row.amount : null;
    const held = row ? (heldPerGrant.get(c.grantId) ?? row.remaining) : null;
    const restoring = restoredPerGrant.get(c.grantId) ?? 0;
    // `held` is the row's CURRENT holding — heldPerGrant already carries this
    // call's restores — so what has to fit is held + this portion. Adding
    // `restoring` again (pass 32) double-counted everything this call had
    // restored so far: on a healthy row the second consumption naming the same
    // grant read 80 + 20 + 20 > 100 and refused a refund that fit exactly,
    // silently shrinking a failing job's refund by the consumed portion while
    // the log blamed an invariant nothing was violating. `restoring` is still
    // what the write-off clamp's target arithmetic needs below.
    if (cap !== null && held !== null && held + c.amount > cap) {
      if (held > cap && cap >= restoring + c.amount) {
        // Clamp to (cap - what this call still has to restore - this portion),
        // so the increment below lands at cap - restoring and no state in
        // between crosses the CHECK. The clamp also writes the balance down by
        // the same amount (see writeOffExcessTx), so credits == SUM(remaining)
        // holds throughout.
        const target = cap - restoring - c.amount;
        await writeOffExcessTx(
          tx,
          userId,
          c.grantId,
          held,
          cap,
          target,
          "refund of a failing job needed the room",
        );
        heldPerGrant.set(c.grantId, target);
      } else {
        // Either the row is legitimately at its cap — this consumption was
        // already refunded, and minting here would be free credits — or it is a
        // degenerate legacy row whose `amount` is smaller than the portion being
        // restored, where nothing can make the increment fit. A degenerate row is
        // still made writable (the excess is written off, or the next statement
        // to touch it aborts) but the portion is reported rather than restored.
        if (held > cap) {
          // Down to `cap`, not to 0: `cap` is the row's own amount — the
          // backed, legal holding — and everything above it is the unbacked
          // legacy excess this write-off exists to remove. Writing to 0 took
          // the backed credits with the excess (the row-side write and the
          // balance debit move together, so the account simply ended poorer —
          // consistent, so nothing fired) for a customer whose only sin was a
          // hand-repaired row.
          await writeOffExcessTx(
            tx,
            userId,
            c.grantId,
            held,
            cap,
            cap,
            `row smaller than the refund (amount ${cap}, restoring ${c.amount})`,
          );
          heldPerGrant.set(c.grantId, cap);
        }
        console.warn(
          `[ledger] refund of ${c.amount} credit(s) refused by grant ${c.grantId}: it holds ${held}/${cap} and the invariant forbids remaining > amount — not restored (user ${userId}); run scripts/repair-credit-invariant.ts --fix`,
        );
        notRestored += c.amount;
        continue;
      }
    }
    restoredPerGrant.set(c.grantId, (restoredPerGrant.get(c.grantId) ?? 0) + c.amount);
    await tx.creditGrant.update({
      where: { id: c.grantId },
      data: { remaining: { increment: c.amount } },
    });
    // The map's value is the row's current holding, so it must come from what
    // the write-off LEFT (if this iteration ran one) — not from `held`, which
    // is the pre-write-off value: tracking that would make the next occurrence
    // read an inflated row and take the write-off branch again, destroying the
    // customer's BACKED credits while keeping credits == SUM(remaining) intact.
    heldPerGrant.set(c.grantId, (heldPerGrant.get(c.grantId) ?? held ?? row.remaining) + c.amount);
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
        cycleOrderId: bucket.cycleOrderId,
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
// The instant is REQUIRED (pass 37): the default used to be `new Date()`, the
// app clock, and it is the whole reason pass 35 exists — dailyCheckin now
// passes the database's now(), and a future caller that drops the argument
// would silently reintroduce "tomorrow's key tonight" (two keys for one
// database day, so the unique index cannot see the double grant). The type
// checker names every caller instead.
export function checkinDateKey(now: Date): string {
  const tz = process.env.CHECKIN_TIMEZONE || "Asia/Shanghai";
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    fmtCache.set(tz, fmt);
  }
  return fmt.format(now);
}

export async function dailyCheckin(userId: string): Promise<CheckinResult> {
  return prisma.$transaction(async (tx) => {
    // The day key is a MONEY boundary — "one grant per local day" is what makes
    // the check-in worth 2 credits a day instead of 2 credits per request — and
    // its only enforcement is @@unique(userId, date) over this string. It came
    // from the APP clock (`checkinDateKey()` -> `new Date()`), which is not an
    // authority anywhere else in this file: a host 15m25s off the database (the
    // skew vitest.setup.ts exists to refuse) writes tomorrow's key tonight, and
    // two instances either side of local midnight write two DIFFERENT keys for
    // ONE database day. The unique index cannot see that — the rows disagree —
    // so the account collects the grant twice. The same conversion as
    // fulfillOrder / cycleUsageTx / revokePlanEntitlementTx (pass 26) and the
    // worker's isFreeTier (pass 34); this was the last one (pass 35).
    // checkinDateKey still renders the key in CHECKIN_TIMEZONE, so the day
    // boundary stays the user's local midnight — what is the database's now is
    // the INSTANT, not the timezone.
    const date = checkinDateKey(await dbNow(tx));
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

// Grant the 30-credit signup bonus. Pass the caller's transaction when the
// bonus has to be atomic with the state change that earned it (pass 39): the
// verification, auto-verification and OAuth-creation paths each used to commit
// that state and then call this in a SECOND transaction, so a failure between
// them left a verified account (or a created OAuth account, which no later
// sign-in re-creates) permanently without the bonus — the token was consumed
// and there was no retry path.
export async function signupBonus(userId: string, tx?: Prisma.TransactionClient) {
  if (tx) return grantCreditsTx(tx, userId, "SIGNUP_BONUS", 30, null, "none", null, "signup bonus");
  return prisma.$transaction((t) =>
    grantCreditsTx(t, userId, "SIGNUP_BONUS", 30, null, "none", null, "signup bonus"),
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
    if (kind === "plan" && planId) {
      // Hold every plan order of this account, ascending id — the same total
      // order the two erasure sweeps use — BEFORE anything else in this
      // transaction.
      //
      // Why it has to exist: the refund transaction flips the order with a locked
      // UPDATE and only THEN runs revokeOrderCreditsTx, whose single
      // `SELECT … FOR UPDATE` snapshots the grants; a ROLLOVER grant inserted
      // after that snapshot is invisible to it. cycleUsageTx's refund witness is
      // an unlocked read of the funding order's status, so while the refund is
      // uncommitted it reads "paid" and the renewal mints 30–100% carryover for
      // a cycle that is being clawed back — refunded money AND retained credits,
      // repeatable every cycle. The existing User lock cannot close it: the
      // refund's snapshot-taking statement runs BEFORE the statement that waits
      // on the User row.
      //
      // With the funding order's row lock held from before the status read to
      // commit, the two transactions can only serialize: either the refund
      // commits first (the read below sees "refunded" → revoked = granted → no
      // carryover) or this one commits first (the refund's post-CAS snapshot
      // sees the committed ROLLOVER and revokes it with the rest).
      //
      // Ordering is the whole point, and it is why this is the FIRST statement
      // rather than a lock taken beside the User lock below: the claim that
      // follows takes the INCOMING order's row lock, so claiming first and then
      // acquiring this ascending set is a non-monotone multi-lock. Two
      // concurrent fulfillments for one account (a double-clicked checkout, two
      // provider deliveries — the case the User lock below documents) each
      // holding their own order and each waiting for the other is a 40P01, and
      // the payment webhook has no deadlock retry.
      await client.$queryRaw(
        Prisma.sql`SELECT id FROM "Order" WHERE "userId" = ${userId} AND kind = 'plan' ORDER BY id FOR UPDATE`,
      );
    }
    // The fulfillment's own instant, on the DATABASE's clock, taken once and
    // reused below. `now()` is the transaction's start time and is stable
    // inside it, so hoisting the read changes no comparison — while `paidAt`
    // was the last app-clock write in this function (pass 37): a host skewed
    // from the database stamped the order's payment earlier or later than the
    // CreditGrant rows the same transaction created, so an operator
    // reconciling "paid at" against the grant's createdAt could read a grant
    // that predates its own payment — the visible shape of a mis-grant.
    const fulfilledAt = await dbNow(client);
    // Atomic claim: only the first fulfillment of a pending order wins, so two
    // distinct signed events for the same order (or a retry racing the
    // original) can never both pass the status check and grant credits twice.
    // Claiming strictly from "pending" also blocks re-fulfillment after a
    // refund flips the order to "refunded".
    const claim = await client.order.updateMany({
      where: { id: orderId, status: "pending" },
      data: { status: "paid", paidAt: fulfilledAt },
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
      // The renewal's own clock is the database's too: this value decides whether
      // an early renewal EXTENDS the paid cycle or restarts it, when the carryover
      // gate opens, and the deadline of the grant this transaction is about to
      // mint — which spendCreditsTx and the sweep later compare against now().
      // Already read above (paidAt); inside one transaction now() is one value.
      const now = fulfilledAt;
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
        //
        // WHICH key names the measured cycle depends on which clock ended it
        // (pass 36), and using the wrong one is what made the witness delete a
        // cycle's carryover instead of protecting it. The keys:
        //
        //  - Grant clock (`fundingExpiresAt <= now`, the ordinary path): the
        //    cycle's identity IS the time bound — a carryover for cycle C can
        //    only be minted at or after C's end (the gate above requires it),
        //    and a LATER cycle's carryover can never have been minted before
        //    that later cycle ended, so `createdAt >= C.expiresAt` names
        //    exactly "a carryover already paid for C". Both sides of the
        //    comparison are the database's: createdAt is the column default
        //    now(), the expiry is the stored grant deadline.
        //
        //    The refId key must NOT be OR'd in here. It names the cycle's
        //    funding ORDER, and the rollover stamp can point at an order that
        //    did not fund the measured cycle: a LEGACY grant (the
        //    20260811080000 migration backfilled nothing, so refId is null)
        //    stamps its carryover with the INCOMING order — the one funding
        //    the cycle AFTER it — so the next renewal measured cycle 1, found
        //    its own incoming order on cycle L's carryover, and read that as
        //    "cycle 1 was already paid for", silently deleting cycle 1's 30%
        //    (probed: legacy cycle → 600 minted for the legacy month, then
        //    ZERO for the first funded month; the following cycle pays again).
        //    The time bound cannot make that mistake: cycle L's carryover was
        //    minted AT L's end, strictly before cycle 1's end.
        //
        //  - Plan clock only (the fallback: an operator correction, or a test
        //    rewinding planRenewsAt, with the grant still unexpired): there is
        //    no ended-by-expiry cycle to time-bound, so the refId key is used
        //    as before. This is the shape the previous version relied on for
        //    its legacy coverage; it is kept only where it is the ONLY
        //    available identity.
        const cycleEndedByGrantClock = usage.fundingExpiresAt !== null && usage.fundingExpiresAt <= now;
        const witness = cycleEndedByGrantClock
          ? [{ createdAt: { gte: usage.fundingExpiresAt as Date } }]
          : usage.fundingRefId
            ? [{ refId: usage.fundingRefId }]
            : [];
        if (rollover > 0 && witness.length) {
          const alreadyPaid = await client.creditGrant.count({
            where: { userId, source: "ROLLOVER", OR: witness },
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
          // The renewal order whose cycle this carryover is spent in — the
          // other half of its provenance (refId names the cycle it came from).
          orderId,
        );
      }
    } else {
      // The pack's deadline is read by SQL everywhere it matters —
      // spendCreditsTx's `"expiresAt" > now()` and runExpiry's sweep — and it
      // was the last grant deadline still derived from the APP clock, so a
      // host-vs-database skew moved the whole validity window by the skew
      // (probed: 2h skew → 2h-shifted expiry). The plan branch above already
      // derives `renew` from dbNow; this is its sibling (same value: see above).
      const now = fulfilledAt;
      const expiresAt = new Date(now.getTime() + PACK_VALIDITY_MS);
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
  //
  // Re-scan until a pass turns up no row the previous passes did not see.
  // `SELECT … FOR UPDATE` fixes its snapshot when the STATEMENT starts, so this
  // revoke blocking on a grant lock held by a job's terminal refund — and that
  // refund then INSERTING the replacement grant for an expired portion
  // (refundCreditsTx's expiredByRef branch, stamped with this same order's
  // refId on purpose) — resumes on a pre-insert snapshot that cannot see the
  // new row. The order flips, the tier is revoked, and the drained quota
  // survives as spendable credits stamped with the refunded order, for good:
  // every later refund event CASes to zero and is acked. Re-scanning closes it
  // because a replacement can only be inserted by a transaction that held the
  // row lock of a grant this scan also matches — the grant being replaced
  // carries the order's refId — so this scan waits for that transaction, and
  // the pass after the wait sees the insert. A pass that adds nothing ends it:
  // the only inserters are job-failure refunds, bounded by the per-account
  // in-flight cap, and the caller's transaction timeout bounds a hostile
  // stream regardless.
  const seen = new Set<string>();
  let revoked = 0;
  for (;;) {
    const grants = await tx.$queryRaw<Array<{ id: string; remaining: number }>>(
      Prisma.sql`SELECT id, remaining FROM "CreditGrant"
        WHERE ("refId" = ${order.id} AND "refType" = 'order')
           OR "cycleOrderId" = ${order.id}
        ${GRANT_LOCK_ORDER}
        FOR UPDATE`,
    );
    const fresh = grants.filter((g) => !seen.has(g.id));
    if (fresh.length === 0) break;
    for (const g of fresh) {
      seen.add(g.id);
      if (g.remaining <= 0) continue;
      await tx.creditGrant.update({ where: { id: g.id }, data: { remaining: 0 } });
      revoked += g.remaining;
    }
  }
  // The renewal that minted a carryover also records the renewal order in
  // cycleOrderId, which the revoke scan above now matches; this block remains
  // for rows written before that column existed (and for any operator-created
  // carryover whose cycleOrderId is null). The carryover expires with this
  // order's SUBSCRIPTION grant (both are written with `renew` in the same
  // transaction), so that shared deadline names exactly the grants this
  // fulfillment minted; an earlier or later fulfillment's `renew` is a
  // different instant.
  const subscription = await tx.$queryRaw<Array<{ expiresAt: Date }>>(Prisma.sql`
    SELECT "expiresAt" FROM "CreditGrant"
    WHERE "refId" = ${order.id} AND "refType" = 'order' AND "source" = 'SUBSCRIPTION'
    LIMIT 1
  `);
  if (subscription.length > 0) {
    const rollovers = await tx.$queryRaw<Array<{ id: string; remaining: number }>>(
      Prisma.sql`SELECT id, remaining FROM "CreditGrant"
        WHERE "userId" = ${order.userId} AND "source" = 'ROLLOVER'
          AND "cycleOrderId" IS NULL
          AND "expiresAt" = ${subscription[0].expiresAt}
        ${GRANT_LOCK_ORDER}
        FOR UPDATE`,
    );
    for (const g of rollovers) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      if (g.remaining <= 0) continue;
      await tx.creditGrant.update({ where: { id: g.id }, data: { remaining: 0 } });
      revoked += g.remaining;
    }
  }
  // No spendable remainder (already spent, or drained and revoked elsewhere):
  // nothing to take, so no ledger entry either — a zero-delta REVOKE would
  // just be noise in the cycle-usage window.
  if (revoked <= 0) return 0;
  // The debit is clamped to what the BALANCE COLUMN holds, exactly like
  // writeOffExcessTx's repair — because on a legacy-drifted account the two
  // disagree. The invariant (User.credits == SUM(remaining)) is enforced on
  // every write, but rows that predate it were never scanned (the CHECK is
  // NOT VALID), so an account can hold FEWER credits than its own grants say.
  // The unclamped debit then threw insufficient-credits from addCreditsTx and
  // rolled back this whole webhook transaction: the order never left "paid"
  // (every provider retry reproduced the 500), the credits stayed granted, and
  // revokePlanEntitlementTx — which runs only after this returns — never ran,
  // so a refunded subscription kept its paid tier. The refund has already
  // happened at the provider; the app side must always be able to catch up,
  // and scripts/repair-credit-invariant.ts is the report for the residue.
  //
  // A healthy account never hits this: its balance is the sum of its grant
  // rows, so credits >= revoked by construction. Only the already-broken
  // direction can clamp, and clamping there moves the account TOWARD
  // consistency (the unbacked excess the balance never held is discarded with
  // the grant rows) rather than minting or destroying backed credits. The read
  // is a snapshot on purpose, for the same reason writeOffExcessTx documents:
  // a User-row FOR UPDATE here would add a grant→user lock edge against
  // erasure's user→grants cascade, and a concurrent commit that lowers the
  // balance past the clamp simply makes addCreditsTx refuse and the provider's
  // retry recompute — no state written.
  const holder = await tx.user.findUnique({ where: { id: order.userId }, select: { credits: true } });
  if (!holder) throw new Error("user-not-found");
  const debit = Math.min(revoked, Math.max(0, holder.credits));
  if (debit < revoked) {
    console.warn(
      `[ledger] refund revoke for order ${order.id} clamped from ${revoked} to ${debit}: the account balance (${holder.credits}) is below the credits the refunded order's grants still hold — a legacy invariant drift (run scripts/repair-credit-invariant.ts); the refund and the tier revocation still complete (user ${order.userId})`,
    );
  }
  if (debit <= 0) return 0;
  await addCreditsTx(tx, order.userId, "REVOKE", -debit, "order", order.id, "credits revoked on payment refund");
  return debit;
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
      expiresAt: { gt: await dbNow(tx) },
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
  // concerns; conflating it is what made this differ from spendCreditsTx.
  //
  // The `remaining > 0` filter is NOT part of the lock predicate, for the same
  // reason revokeOrderCreditsTx's is not: a grant sitting at remaining = 0 is
  // exactly the state a queued or running job leaves its pre-auth in, and it is
  // the state a clawback racing that job must serialize with — otherwise the
  // job's later terminal failure restores the credits the admin just took
  // (refundCreditsTx increments remaining on a grant this statement never
  // locked) while the ADMIN ledger row records them as removed. The row count
  // is small (one user's grants), so locking the zero-remaining ones costs
  // nothing; the test moves into the loop, where it only decides whether there
  // is anything to take.
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      remaining: number;
      amount: number;
      source: string;
      expiresAt: Date | null;
      createdAt: Date;
      refType: string | null;
      refId: string | null;
    }>
  >(
    Prisma.sql`SELECT id, remaining, amount, source, "expiresAt", "createdAt", "refType", "refId" FROM "CreditGrant"
      WHERE "userId" = ${userId}
      ${GRANT_LOCK_ORDER}
      FOR UPDATE`,
  );
  // Clawbacks are fraud recovery: the operator is taking back value the
  // account can still spend. Ordering purely by expiry did the opposite when
  // the sweep had not yet collected an expired grant — it drained the dead
  // grant first (its deadline is earliest), reported success and moved
  // User.credits, while every SPENDABLE credit stayed put. A user could keep
  // generating on live credits after an operator had clawed back their whole
  // displayed balance. Take unexpired rows first (free sources still lead, as
  // before), then the expired remainder so the raw balance the admin console
  // shows still falls by the full amount. `now` is the database's clock, the
  // one spendCreditsTx and the sweep judge deadlines by.
  const now = await dbNow(tx);
  const freeFirst = (s: string) => (s === "SIGNUP_BONUS" || s === "CHECKIN" || s === "ADMIN" ? 0 : 1);
  const isExpired = (r: { expiresAt: Date | null }) =>
    r.expiresAt !== null && r.expiresAt.getTime() <= now.getTime() ? 1 : 0;
  const takeOrder = [...rows].sort((a, b) => {
    const fa = freeFirst(a.source) - freeFirst(b.source);
    if (fa !== 0) return fa;
    const xa = isExpired(a) - isExpired(b);
    if (xa !== 0) return xa;
    const ea = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const eb = b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (ea !== eb) return ea - eb;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  let needed = amount;
  // Which order's credits the clawback took, so the ledger row can say it
  // (pass 36). Before this, every clawback wrote ONE anonymous row — refType
  // "admin", refId the operator — and cycleUsageTx's revoked scan (REVOKE rows
  // naming the cycle's funding order) could not see it: the plan quota was gone
  // from the account but the measurement still counted it as UNUSED, so the
  // next renewal paid 30% carryover on credits an operator had already taken
  // back (probed: identical 600 carryover with and without a full clawback of
  // the cycle's quota). The operator's own attribution moves to
  // LedgerEntry.actorId, which is the only slot that can hold both facts.
  const byOrder = new Map<string, number>();
  let unattributed = 0;
  for (const r of takeOrder) {
    if (needed <= 0) break;
    // Same legacy-row repair as spendCreditsTx: a row above its own amount
    // cannot be decremented, and the operator's compensation path is the last
    // one that should 500 on a bookkeeping state.
    if (r.remaining > r.amount) {
      await writeOffExcessTx(
        tx,
        userId,
        r.id,
        r.remaining,
        r.amount,
        r.amount,
        "repaired while clawing back from it",
      );
      r.remaining = r.amount;
    }
    // A NEGATIVE remaining predates the CHECK constraint (it is NOT VALID) and
    // only scripts/repair-credit-invariant.ts should ever see it. This loop used
    // to treat it as takable credit: take = min(-5, needed) = -5, `decrement:
    // -5` INCREASED the row from -5 to 0 (minting 5 row-credits with no GRANT
    // ledger row), and `needed -= take` demanded 5 MORE from the other grants —
    // so a clawback of $X debited X+5, wrote a ledger row of -(X+5) for an
    // admin request of -X, and left User.credits below SUM(remaining) (probed).
    // There is nothing to take from a negative lot and nothing to repair here;
    // skip it and let the remaining amount come from rows that hold credits.
    if (r.remaining <= 0) continue;
    const take = Math.min(r.remaining, needed);
    await tx.creditGrant.update({
      where: { id: r.id },
      data: { remaining: { decrement: take } },
    });
    if (take > 0) {
      if (r.refType === "order" && r.refId) byOrder.set(r.refId, (byOrder.get(r.refId) ?? 0) + take);
      else unattributed += take;
    }
    needed -= take;
  }
  if (needed > 0) throw new Error("insufficient-credits");
  // One row per attribution group: the credited order for what came out of
  // order-backed grants, and the anonymous operator row for free/admin grants
  // (the FIRST class taken, so a compensating grant or signup bonus is
  // consumed before any purchased credit). The deltas sum to -amount, so the
  // invariant and the balance walk are unchanged; what changes is that
  // cycleUsageTx can now see a clawback of the plan quota. Note the ≤ 2 rows
  // are deliberate: an operator's action stays ONE ledger story (same note,
  // same actorId), not one row per grant.
  for (const [orderRef, taken] of byOrder) {
    await addCreditsTx(tx, userId, "ADMIN", -taken, "order", orderRef, note, adminId);
  }
  if (unattributed > 0) {
    await addCreditsTx(tx, userId, "ADMIN", -unattributed, "admin", adminId, note, adminId);
  }
}
