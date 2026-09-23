import { requireUserId, ok, fail, enforceUserRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const userId = await requireUserId();
    // Per-account, like the sibling reads: the middleware's per-IP bucket is
    // per-instance and IP rotation lifts it.
    const limited = await enforceUserRateLimit(userId, "ledger-list", 60, 60_000);
    if (limited) return fail(limited);
    const entries = await prisma.ledgerEntry.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return ok({ entries });
  } catch (e) {
    return fail(e);
  }
}
