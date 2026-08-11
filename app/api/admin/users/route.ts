import { requireAdmin } from "@/lib/admin";
import { ok, fail } from "@/lib/api";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    await requireAdmin();
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const take = 20;
    const where = q
      ? { OR: [{ email: { contains: q, mode: "insensitive" as const } }, { name: { contains: q, mode: "insensitive" as const } }] }
      : undefined;
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * take,
        take,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          credits: true,
          plan: true,
          planRenewsAt: true,
          emailVerified: true,
          totpEnabled: true,
          createdAt: true,
        },
      }),
      prisma.user.count({ where }),
    ]);
    return ok({ users, total, page, pages: Math.ceil(total / take) });
  } catch (e) {
    return fail(e);
  }
}
