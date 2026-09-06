import { requireUserId, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/prisma";

// GDPR / PIPL data export.
export async function POST() {
  try {
    const userId = await requireUserId();
    // Bounded take so a hoarded account cannot force an unbounded response.
    const [user, ledger, images, jobs, orders] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true, credits: true, plan: true, planRenewsAt: true, createdAt: true },
      }),
      prisma.ledgerEntry.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, take: 5000 }),
      prisma.image.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, take: 5000 }),
      prisma.job.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, take: 5000 }),
      prisma.order.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, take: 5000 }),
    ]);
    return ok({ exportedAt: new Date().toISOString(), data: { user, ledger, images, jobs, orders } });
  } catch (e) {
    return fail(e);
  }
}
