import { prisma } from "./prisma";
import { dbNow } from "./ledger";

const DAY_MS = 24 * 60 * 60 * 1000;

// The balance the caller may actually SPEND, which is not always User.credits:
// spendability ends at expiresAt (spendCreditsTx filters `"expiresAt" > now()`)
// while the sweep that zeroes expired grants runs DAILY, so inside that window
// the column still counts credits every generation route refuses. Evaluated in
// SQL on the database's clock so it agrees exactly with the spend path. One
// helper because the two readers disagreed (pass 38): /api/me computed this and
// the workbench showed the spendable number, while /api/checkin reported the
// raw column — an account with unswept expired grants was told `balance: 142`
// next to /api/me's 42, and a client rendering the check-in response advertised
// credits the very next generate call refused (probed). `expired` is reported
// rather than hidden so a caller can explain the difference.
export async function spendableBalance(userId: string): Promise<{ spendable: number; expired: number }> {
  const [held] = await prisma.$queryRaw<Array<{ spendable: bigint; expired: bigint }>>`
    SELECT
      COALESCE(SUM(CASE WHEN "expiresAt" IS NULL OR "expiresAt" > now() THEN remaining ELSE 0 END), 0)::bigint AS spendable,
      COALESCE(SUM(CASE WHEN "expiresAt" IS NOT NULL AND "expiresAt" <= now() THEN remaining ELSE 0 END), 0)::bigint AS expired
    FROM "CreditGrant" WHERE "userId" = ${userId} AND remaining > 0`;
  return { spendable: Number(held?.spendable ?? 0), expired: Number(held?.expired ?? 0) };
}

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
    // A hard ceiling like every sibling list (/api/ledger 100, gallery 60).
    // Grants are expensive to create, so the practical list is small — but this
    // feed is rendered as a banner on every workbench load and had no bound at
    // all; an account with an unusually large grant history made the response
    // grow without limit. The soonest-expiring 100 are what the banner can act
    // on anyway.
    take: 100,
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
