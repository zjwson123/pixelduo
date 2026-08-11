import { requireUserId, ok, fail } from "@/lib/api";
import { prisma } from "@/lib/prisma";

// GDPR / PIPL data export.
export async function POST() {
  try {
    const userId = await requireUserId();
    const [user, ledger, images, jobs, orders] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true, credits: true, plan: true, planRenewsAt: true, createdAt: true },
      }),
      prisma.ledgerEntry.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.image.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.job.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.order.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
    ]);
    return ok({ exportedAt: new Date().toISOString(), data: { user, ledger, images, jobs, orders } });
  } catch (e) {
    return fail(e);
  }
}
