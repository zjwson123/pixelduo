import { requireAdmin } from "@/lib/admin";
import { ok, fail, clampPage, enforceUserRateLimit } from "@/lib/api";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const adminId = await requireAdmin();
    // Account-keyed leg, like every sibling read — the orders listing was one of
    // the last authenticated routes with only middleware's coarse 300/min.
    const limited = await enforceUserRateLimit(adminId, "admin-orders", 60, 60_000);
    if (limited) return fail(limited);
    const url = new URL(req.url);
    // NaN-guard: garbage ?page= must fall back to 1, not produce skip: NaN.
    // clampPage also caps the top end, where a huge finite value overflowed
    // the skip into a rejected query (masked 500).
    const page = clampPage(url.searchParams.get("page"));
    const take = 50;
    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * take,
        take,
        select: {
          id: true,
          userId: true,
          kind: true,
          provider: true,
          amountUsd: true,
          credits: true,
          status: true,
          createdAt: true,
          paidAt: true,
        },
      }),
      prisma.order.count(),
    ]);
    return ok({ orders, total, page, pages: Math.ceil(total / take) });
  } catch (e) {
    return fail(e);
  }
}
