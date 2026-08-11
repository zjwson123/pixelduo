import { prisma } from "./prisma";
import { addCreditsTx } from "./ledger";

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
    for (const userId of userIds) {
      await prisma.$transaction(async (tx) => {
        const grants = await tx.creditGrant.findMany({
          where: { userId, remaining: { gt: 0 }, expiresAt: { lte: new Date() } },
        });
        const sum = grants.reduce((acc, g) => acc + g.remaining, 0);
        if (sum <= 0) return;
        await tx.creditGrant.updateMany({
          where: { id: { in: grants.map((g) => g.id) } },
          data: { remaining: 0 },
        });
        await addCreditsTx(tx, userId, "EXPIRE", -sum, "none", null, `expired credits (${grants.length} grant(s))`);
        total += sum;
      });
    }
  }
  return total;
}
