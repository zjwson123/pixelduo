import { requireUserId, ok, fail, enforceUserRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";

// GDPR / PIPL data export.
export async function POST() {
  try {
    const userId = await requireUserId();
    // This is the most expensive read in the app (up to 25k rows serialized
    // into one unpaged body), so it needs a limit of its own — per ACCOUNT, and
    // the only leg: the per-IP one it carried first let one account spend the
    // bucket its neighbours' erasure/export also needed (see
    // enforceUserRateLimit).
    const limited = await enforceUserRateLimit(userId, "export", 3, 60 * 60_000);
    if (limited) return fail(limited);
    // Bounded take so a hoarded account cannot force an unbounded response.
    const [user, ledger, images, jobs, orders, feedback] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true, credits: true, plan: true, planRenewsAt: true, createdAt: true },
      }),
      prisma.ledgerEntry.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, take: 5000 }),
      prisma.image.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, take: 5000 }),
      prisma.job.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, take: 5000 }),
      prisma.order.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, take: 5000 }),
      // Messages the user sent while signed in. Anonymous reports carry no
      // userId and are therefore not attributable, so they cannot be included.
      prisma.feedback.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, take: 5000 }),
    ]);
    return ok({ exportedAt: new Date().toISOString(), data: { user, ledger, images, jobs, orders, feedback } });
  } catch (e) {
    return fail(e);
  }
}
