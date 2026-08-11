import { requireAdmin } from "@/lib/admin";
import { ok, fail } from "@/lib/api";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    await requireAdmin();
    const url = new URL(req.url);
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
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
