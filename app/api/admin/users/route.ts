import { requireAdmin } from "@/lib/admin";
import { ok, fail, clampPage, enforceUserRateLimit, queryText } from "@/lib/api";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const adminId = await requireAdmin();
    // The admin reads were the last authenticated routes with no route-level
    // bucket (middleware's coarse 300/min was the only ceiling). `?q=` is an
    // unindexed ILIKE scan over User, so a rogue or stolen admin session could
    // load the shared database at 300 requests a minute; every sibling read has
    // had an account-keyed leg since pass 21.
    const limited = await enforceUserRateLimit(adminId, "admin-users", 60, 60_000);
    if (limited) return fail(limited);
    const url = new URL(req.url);
    const q = (queryText(url.searchParams.get("q"), 120) ?? "").trim().toLowerCase();
    // NaN-guard: garbage ?page= must fall back to 1, not produce skip: NaN.
    // clampPage also caps the top end, where a huge finite value overflowed
    // the skip into a rejected query (masked 500).
    const page = clampPage(url.searchParams.get("page"));
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
