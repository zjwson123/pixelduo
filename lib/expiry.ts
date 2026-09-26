import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { addCreditsTx, GRANT_LOCK_ORDER, idChunks } from "./ledger";
import { captureError } from "./observability";

const BATCH_SIZE = 200;

// Sweep credits whose grants have expired (12-month packs, cycle-end
// subscription quota, next-cycle rollover). Invariant is preserved:
// User.credits == SUM(CreditGrant.remaining) before and after.
export async function runExpiry(): Promise<number> {
  let total = 0;
  // Cursor pagination, not "re-query from the top and stop when a batch makes no
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
  // A cursor simply walks past them. The per-user transaction still sweeps ALL of
  // that account's expired rows, so the walk is short: each step retires 200 rows
  // from the filter.
  let cursor: string | null = null;
  for (;;) {
    // Built separately: a conditional spread inside the same object literal makes
    // TypeScript try to infer `expiring` from an expression that mentions
    // `cursor`, which it then infers from `expiring` (TS7022).
    const page: { cursor?: { id: string }; skip?: number } = cursor
      ? { cursor: { id: cursor }, skip: 1 }
      : {};
    const expiring = await prisma.creditGrant.findMany({
      ...page,
      where: { remaining: { gt: 0 }, expiresAt: { lte: new Date() } },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: BATCH_SIZE,
      select: { id: true, userId: true },
    });
    if (expiring.length === 0) break;
    cursor = expiring[expiring.length - 1].id;

    const userIds = [...new Set(expiring.map((g) => g.userId))];
    for (const userId of userIds) {
      const expired = await prisma
        .$transaction(async (tx) => {
          // Lock the user's expiring rows FOR UPDATE so two overlapping sweeps
          // (manual run racing the daily cron) serialize: the loser re-reads
          // zeroed grants and skips, instead of double-deducting a stale sum
          // from user credits. Locked in GRANT_LOCK_ORDER like every other
          // grant-locking statement: without an ORDER BY the planner is free to
          // return rows in physical order, which HOT updates reshuffle, so a
          // sweep racing an adminClawbackTx over the same expired rows could
          // take them in the opposite sequence and deadlock (one side aborts;
          // the clawback surfaces as a 500, and the sweep stops its batch
          // early). It was the only statement in the codebase outside the
          // documented order.
          const grants = await tx.$queryRaw<Array<{ id: string; remaining: number }>>(
            Prisma.sql`SELECT id, remaining FROM "CreditGrant"
              WHERE "userId" = ${userId} AND remaining > 0 AND "expiresAt" <= now()
              ${GRANT_LOCK_ORDER}
              FOR UPDATE`,
          );
          const sum = grants.reduce((acc, g) => acc + g.remaining, 0);
          if (sum <= 0) return 0;
          // Chunked: `updateMany` never gets Prisma's automatic `in` splitting,
          // so one account holding 32,768+ expired grants threw `too many bind
          // variables` here. The throw was caught below as a per-user skip —
          // which left `progressed` false and therefore broke OUT of the batch
          // loop, so that account's unswept credits stopped the sweep for every
          // other account too, indefinitely. The rows are already locked FOR
          // UPDATE by the statement above, so splitting costs nothing.
          for (const part of idChunks(grants.map((g) => g.id))) {
            await tx.creditGrant.updateMany({
              where: { id: { in: part }, remaining: { gt: 0 } },
              data: { remaining: 0 },
            });
          }
          await addCreditsTx(tx, userId, "EXPIRE", -sum, "none", null, `expired credits (${grants.length} grant(s))`);
          return sum;
        })
        .catch((e) => {
          // A broken invariant (already-negative balance) must not spin-loop
          // the cron on the same rows forever — skip and continue. Reported, not
          // swallowed: this used to discard every failure silently, so a sweep
          // that failed on every row printed the same `expired credits: 0` as a
          // sweep that had nothing to do, and an operator had no signal that
          // EXPIRE bookkeeping had been broken for weeks — unspendable credits,
          // no ledger rows — until a customer noticed.
          captureError(e, { scope: "expiry-sweep", userId });
          return 0;
        });
      if (expired > 0) {
        total += expired;
      }
    }
  }
  return total;
}
