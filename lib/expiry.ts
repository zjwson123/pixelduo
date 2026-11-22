import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { addCreditsTx, GRANT_LOCK_ORDER, ID_CHUNK, idChunks } from "./ledger";
import { captureError } from "./observability";

const BATCH_SIZE = 200;

// Grants one transaction will retire, at most.
//
// Deliberately equal to ID_CHUNK: one locked set, one `updateMany`, one ledger
// entry — and, more importantly, a bounded amount of work per transaction.
// Prisma's interactive transactions default to a 5-second timeout, and the
// per-user transaction below used to lock and zero EVERY expired grant the
// account holds in one go. A backlog large enough to cross that timeout did not
// merely fail once: the throw is caught as a per-user skip, the page cursor
// moves past the account, and the next run starts over at the same rows — so
// the account was never swept, and every sweep of the daily pass burned the
// timeout again (the pass-19 "one account holds the sweep hostage" shape,
// reached through the transaction timeout this time rather than through a
// broken invariant). Measured locally: 33k rows ≈ 1s, i.e. a 5x margin that a
// slower disk, a colder cache or a larger backlog eats. Batching keeps every
// transaction flat regardless of how many rows an account has accumulated, and
// the loop below drains an account completely — the batches are a size limit,
// not a progress limit.
const SWEEP_BATCH = ID_CHUNK;

interface SweepBatch {
  // Credits retired by this transaction.
  sum: number;
  // Grant rows it retired; < SWEEP_BATCH means the account is drained.
  count: number;
}

// One bounded, self-contained sweep step for one account. Every transaction
// either retires all the rows it locked (zeroing `remaining` and deducting
// exactly their sum from the balance) or rolls back whole, so the invariant
// holds between steps and a partial sweep is safe to resume.
async function sweepBatchOnce(userId: string): Promise<SweepBatch> {
  return prisma.$transaction(async (tx) => {
    // Lock the user's expiring rows FOR UPDATE so two overlapping sweeps
    // (manual run racing the daily cron) serialize: the loser re-reads zeroed
    // grants and skips, instead of double-deducting a stale sum from user
    // credits. Locked in GRANT_LOCK_ORDER like every other grant-locking
    // statement: without an ORDER BY the planner is free to return rows in
    // physical order, which HOT updates reshuffle, so a sweep racing an
    // adminClawbackTx over the same expired rows could take them in the
    // opposite sequence and deadlock (one side aborts; the clawback surfaces as
    // a 500, and the sweep stops its batch early). It was the only statement in
    // the codebase outside the documented order. LIMIT + that order is also
    // what keeps two concurrent sweeps from taking disjoint slices in
    // conflicting orders: both walk the same sequence from the front.
    const grants = await tx.$queryRaw<Array<{ id: string; remaining: number }>>(
      Prisma.sql`SELECT id, remaining FROM "CreditGrant"
        WHERE "userId" = ${userId} AND remaining > 0 AND "expiresAt" <= now()
        ${GRANT_LOCK_ORDER}
        LIMIT ${SWEEP_BATCH}
        FOR UPDATE`,
    );
    if (grants.length === 0) return { sum: 0, count: 0 };
    const sum = grants.reduce((acc, g) => acc + g.remaining, 0);
    // Chunked: `updateMany` never gets Prisma's automatic `in` splitting, so a
    // batch this size is fine but a future raise of SWEEP_BATCH is not — and
    // the row count here used to be unbounded, which is what made a 33k-grant
    // account throw `too many bind variables` (caught as a per-user skip, so
    // that account's unswept credits stopped the sweep for everyone else).
    // The rows are already locked FOR UPDATE by the statement above, so
    // splitting costs nothing.
    for (const part of idChunks(grants.map((g) => g.id))) {
      // Raw, not updateMany, for one reason (pass 67): a pre-CHECK row with a
      // NEGATIVE `amount` (the class the CHECK is NOT VALID for and
      // scripts/repair-credit-invariant.ts reports) makes `remaining: 0`
      // violate `0 <= remaining <= amount`, so the whole batch — including every
      // healthy expired grant in it — rolled back and this account was never
      // swept again. The CASE repairs the impossible ceiling in the same write,
      // exactly as writeOffExcessTx does on the spend path.
      await tx.$executeRaw(Prisma.sql`
        UPDATE "CreditGrant"
        SET "remaining" = 0,
            "amount" = CASE WHEN "amount" < 0 THEN 0 ELSE "amount" END
        WHERE id IN (${Prisma.join(part)}) AND "remaining" > 0
      `);
    }
    await addCreditsTx(tx, userId, "EXPIRE", -sum, "none", null, `expired credits (${grants.length} grant(s))`);
    return { sum, count: grants.length };
  });
}

interface ExpiredRow {
  id: string;
  userId: string;
  // `expiresAt` as the database renders it — the page boundary below, never a JS
  // Date (see expiredPage).
  expiresAtText: string;
}

// One page of expired grants, strictly after the last row of the previous page.
//
// A keyset on (expiresAt, id), and specifically NOT Prisma's `cursor`: that
// resolves the cursor row in memory — the query goes out without LIMIT/OFFSET and
// the engine slices the result at the cursor's position — so a cursor row that no
// longer matches the WHERE clause ends the walk. The drain below zeroes exactly
// the rows of the page it was given, the cursor included, so `remaining > 0` no
// longer held for it and every page after the first came back EMPTY. The sweep
// returned after 200 expired rows and reported success: measured with 450 expired
// grants across three accounts, the third account's 150 grants were never touched
// (credits still in the balance, unspendable, no EXPIRE ledger row) and no error
// was raised anywhere. The keyset depends on values, not on the row still being
// there — it survives the row being zeroed by this run, deleted by an account
// erasure, or re-granted by a refund.
//
// The boundary travels as the database's own text rendering of the timestamp and
// is cast back to `timestamp` (session-zone-independent, unlike a JS Date read
// from a naive column and bound back through the session's zone). The filter uses
// the database's `now()`, the same authority the drain's locking SELECT compares
// against — a host clock that disagrees with it would otherwise let this query
// read rows the drain then refuses to touch, and hide rows the database already
// considers expired.
async function expiredPage(after: { expiresAtText: string; id: string } | null): Promise<ExpiredRow[]> {
  const afterFragment = after
    ? Prisma.sql`AND ("expiresAt", id) > (${after.expiresAtText}::text::timestamp, ${after.id})`
    : Prisma.empty;
  return prisma.$queryRaw<ExpiredRow[]>(
    Prisma.sql`SELECT id, "userId", "expiresAt"::text AS "expiresAtText"
      FROM "CreditGrant"
      WHERE remaining > 0 AND "expiresAt" <= now()
      ${afterFragment}
      ORDER BY "expiresAt" ASC, id ASC
      LIMIT ${BATCH_SIZE}`,
  );
}

// Sweep credits whose grants have expired (12-month packs, cycle-end
// subscription quota, next-cycle rollover). Invariant is preserved:
// User.credits == SUM(CreditGrant.remaining) before and after.
export async function runExpiry(): Promise<number> {
  let total = 0;
  // Keyset pagination, not "re-query from the top and stop when a batch makes no
  // progress". That stop condition made the sweep hostage to a single account:
  // an account whose rows can never be swept — the already-broken invariant this
  // file's own catch reports, e.g. credits already 0 while expired grants still
  // hold `remaining > 0`, so `addCreditsTx(-sum)` throws insufficient-credits —
  // stays at the HEAD of the `expiresAt asc` order for ever, and the run that
  // happened to read it in a batch where nothing else progressed returned 0
  // without ever sweeping the accounts behind it. Worse, when another account in
  // the same batch DID progress, the loop kept going and kept re-reading the
  // unsweepable rows: the sweep looked hung (a test that calls it spins until
  // its own timeout, and every later sweep of that run races a stale one).
  // A boundary the page advances past walks over them, whatever they do.
  let cursor: { expiresAtText: string; id: string } | null = null;
  for (;;) {
    const expiring = await expiredPage(cursor);
    if (expiring.length === 0) break;
    const last = expiring[expiring.length - 1];
    cursor = { expiresAtText: last.expiresAtText, id: last.id };

    const userIds = [...new Set(expiring.map((g) => g.userId))];
    for (const userId of userIds) {
      // Drain this account, SWEEP_BATCH rows per transaction. The loop exits on
      // a short batch (nothing left) or on the first failure, which is reported
      // and skipped — a broken invariant (already-negative balance) must not
      // spin-loop the cron on the same rows forever. Reported, not swallowed:
      // this used to discard every failure silently, so a sweep that failed on
      // every row printed the same `expired credits: 0` as a sweep that had
      // nothing to do, and an operator had no signal that EXPIRE bookkeeping had
      // been broken for weeks — unspendable credits, no ledger rows — until a
      // customer noticed.
      for (;;) {
        const step = await sweepBatchOnce(userId).catch((e) => {
          captureError(e, { scope: "expiry-sweep", userId });
          return { sum: 0, count: 0 } as SweepBatch;
        });
        if (step.count === 0) break;
        total += step.sum;
        if (step.count < SWEEP_BATCH) break;
      }
    }
  }
  return total;
}
