import { prisma } from "./prisma";
import { sendCreditExpiryEmail } from "./mail";
import { captureError } from "./observability";

// Ascending so `find` picks the smallest bucket >= daysLeft (e.g. 2 → 3).
const BUCKETS = [1, 3, 7] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

// Send at most one reminder per grant per bucket (7/3/1 days before expiry) for
// paid credits (PURCHASE packs + SUBSCRIPTION quota). Deduplicated by
// CreditReminder(grantId, daysBefore). Failure to send never blocks the cron.
export async function sendExpiryReminders(): Promise<number> {
  const now = new Date();
  const horizon = new Date(now.getTime() + 8 * DAY_MS);
  const grants = await prisma.creditGrant.findMany({
    where: {
      remaining: { gt: 0 },
      // Lower bound too: a grant that already expired but has not been swept
      // yet must not be mailed as "1 day left" (Math.max(1, …) below pins the
      // bucket, so nothing else filters it out).
      expiresAt: { not: null, gt: now, lte: horizon },
      source: { in: ["PURCHASE", "SUBSCRIPTION"] },
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
