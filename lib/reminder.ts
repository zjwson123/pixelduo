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
      expiresAt: { not: null, lte: horizon },
      source: { in: ["PURCHASE", "SUBSCRIPTION"] },
    },
    select: { id: true, userId: true, remaining: true, expiresAt: true },
  });

  let sent = 0;
  for (const g of grants) {
    const daysLeft = Math.max(1, Math.ceil((g.expiresAt!.getTime() - now.getTime()) / DAY_MS));
    const bucket = BUCKETS.find((b) => daysLeft <= b);
    if (!bucket) continue;
    const existing = await prisma.creditReminder.findUnique({
      where: { grantId_daysBefore: { grantId: g.id, daysBefore: bucket } },
    });
    if (existing) continue;
    const user = await prisma.user.findUnique({ where: { id: g.userId }, select: { email: true } });
    if (!user) continue;
    try {
      await sendCreditExpiryEmail(user.email, bucket, g.remaining);
      await prisma.creditReminder.create({
        data: { grantId: g.id, userId: g.userId, daysBefore: bucket },
      });
      sent += 1;
    } catch (e) {
      captureError(e, { grantId: g.id, userId: g.userId, daysBefore: bucket });
    }
  }
  return sent;
}
