import { prisma } from "./prisma";
import { dbNow } from "./ledger";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExpiringCredit {
  id: string;
  source: string;
  remaining: number;
  expiresAt: Date;
  daysLeft: number;
}

// Grants whose remaining credits expire within the horizon (for the
// workbench banner / retention nudges). Only paid sources count.
export async function listExpiringCredits(userId: string, days = 14): Promise<ExpiringCredit[]> {
  // The DATABASE's clock, like spendCreditsTx and the expiry sweep this list
  // must agree with: the comment below promises that nothing is advertised
  // which the spend path refuses, and on the app clock that promise breaks in
  // both directions — a host behind the database showed (and the reminder
  // path mailed) credits whose deadline had passed, one ahead hid credits that
  // were about to be swept. Same class pass 26 moved at the plan boundary.
  const now = await dbNow(prisma);
  const horizon = new Date(now.getTime() + days * DAY_MS);
  const grants = await prisma.creditGrant.findMany({
    where: {
      userId,
      remaining: { gt: 0 },
      // The lower bound matters: without `gt: now` a grant that already expired
      // but has not been swept yet is reported with daysLeft clamped to 1, so
      // the workbench banner promises "1 day left" for credits that
      // spendCreditsTx already refuses to spend. The reminder path already
      // filters this way.
      expiresAt: { not: null, gt: now, lte: horizon },
      // REFUND is the replacement grant refundCreditsTx mints for a portion
      // whose original deadline had passed: spendable, expiring, and — until
      // now — the one paid-source class the banner and the reminders did not
      // count, so exactly the credits a customer most needed warning about
      // were the ones never advertised.
      source: { in: ["PURCHASE", "SUBSCRIPTION", "ROLLOVER", "REFUND"] },
    },
    orderBy: { expiresAt: "asc" },
    select: { id: true, source: true, remaining: true, expiresAt: true },
  });
  const nowMs = now.getTime();
  return grants.map((g) => ({
    id: g.id,
    source: g.source,
    remaining: g.remaining,
    expiresAt: g.expiresAt as Date,
    daysLeft: Math.max(1, Math.ceil((g.expiresAt!.getTime() - nowMs) / DAY_MS)),
  }));
}
