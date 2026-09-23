import { requireUserId, ok, fail, enforceUserRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Current user's purchase history (orders + payment status).
export async function GET() {
  try {
    const userId = await requireUserId();
    const limited = await enforceUserRateLimit(userId, "orders-list", 60, 60_000);
    if (limited) return fail(limited);
    const orders = await prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        kind: true,
        provider: true,
        amountUsd: true,
        credits: true,
        planId: true,
        status: true,
        createdAt: true,
        paidAt: true,
      },
    });
    return ok({ orders });
  } catch (e) {
    return fail(e);
  }
}
