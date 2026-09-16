import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { addCreditsTx, GRANT_LOCK_ORDER } from "./ledger";

const BATCH_SIZE = 200;

// Sweep credits whose grants have expired (12-month packs, cycle-end
// subscription quota, next-cycle rollover). Invariant is preserved:
// User.credits == SUM(CreditGrant.remaining) before and after.
export async function runExpiry(): Promise<number> {
  let total = 0;
  for (;;) {
    const expiring = await prisma.creditGrant.findMany({
      where: { remaining: { gt: 0 }, expiresAt: { lte: new Date() } },
      orderBy: { expiresAt: "asc" },
      take: BATCH_SIZE,
      select: { id: true, userId: true },
    });
    if (expiring.length === 0) break;

    const userIds = [...new Set(expiring.map((g) => g.userId))];
    let progressed = false;
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
          await tx.creditGrant.updateMany({
            where: { id: { in: grants.map((g) => g.id) }, remaining: { gt: 0 } },
            data: { remaining: 0 },
          });
          await addCreditsTx(tx, userId, "EXPIRE", -sum, "none", null, `expired credits (${grants.length} grant(s))`);
          return sum;
        })
        .catch(() => {
          // A broken invariant (already-negative balance) must not spin-loop
          // the cron on the same rows forever — skip and continue.
          return 0;
        });
      if (expired > 0) {
        total += expired;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return total;
}
