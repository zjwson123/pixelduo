import { prisma } from "./prisma";
import { dbNow } from "./ledger";
import { sendCreditExpiryEmail } from "./mail";
import { captureError } from "./observability";

// Ascending so `find` picks the smallest bucket >= daysLeft (e.g. 2 → 3).
const BUCKETS = [1, 3, 7] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

// Send at most one reminder per grant per bucket (7/3/1 days before expiry) for
// expiring paid credits. Deduplicated by CreditReminder(grantId, daysBefore).
// Failure to send never blocks the cron.
//
// The source list matches listExpiringCredits (lib/credits.ts) exactly: pass 28
// rolled ROLLOVER and REFUND into the in-app banner and left this mail behind,
// so a 30% carryover or a REFUND replacement grant — both spendable and both
// expiring, the latter minted exactly when the customer is owed something —
// was advertised in the workbench and silently destroyed for anyone not
// looking at it (probed: banner listed three sources, the mail only PURCHASE).
export async function sendExpiryReminders(): Promise<number> {
  // The DATABASE's clock (see listExpiringCredits): a mail that says "1 day
  // left" is a claim about the deadline the spend path and the expiry sweep
  // enforce, and those run on the database's clock.
  const now = await dbNow(prisma);
  const horizon = new Date(now.getTime() + 8 * DAY_MS);
  const grants = await prisma.creditGrant.findMany({
    where: {
      remaining: { gt: 0 },
      // Lower bound too: a grant that already expired but has not been swept
      // yet must not be mailed as "1 day left" (Math.max(1, …) below pins the
      // bucket, so nothing else filters it out).
      expiresAt: { not: null, gt: now, lte: horizon },
      source: { in: ["PURCHASE", "SUBSCRIPTION", "ROLLOVER", "REFUND"] },
    },
    select: { id: true, userId: true, remaining: true, expiresAt: true },
  });

  let sent = 0;
  for (const g of grants) {
    const daysLeft = Math.max(1, Math.ceil((g.expiresAt!.getTime() - now.getTime()) / DAY_MS));
    const bucket = BUCKETS.find((b) => daysLeft <= b);
    if (!bucket) continue;
    const user = await prisma.user.findUnique({ where: { id: g.userId }, select: { email: true } });
    if (!user) continue;
    try {
      // Claim the reminder BEFORE sending: two overlapping cron runs would
      // otherwise both pass the existence check and the user gets the same
      // reminder twice. The unique (grantId, daysBefore) row is the claim; a
      // failed send releases it so the next run retries.
      await prisma.creditReminder.create({
        data: { grantId: g.id, userId: g.userId, daysBefore: bucket },
      });
    } catch {
      continue; // already claimed by a concurrent run
    }
    try {
      await sendCreditExpiryEmail(user.email, bucket, g.remaining);
      sent += 1;
    } catch (e) {
      await prisma.creditReminder
        .deleteMany({ where: { grantId: g.id, daysBefore: bucket } })
        .catch(() => undefined);
      captureError(e, { grantId: g.id, userId: g.userId, daysBefore: bucket });
    }
  }
  return sent;
}
