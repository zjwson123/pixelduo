import { requireAdmin } from "@/lib/admin";
import { ok, fail, enforceUserRateLimit, queryText } from "@/lib/api";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const adminId = await requireAdmin();
    // Admin reads had no route-level bucket: middleware's coarse 300/min was the
    // only ceiling on a full image listing. Account-keyed like every sibling.
    const limited = await enforceUserRateLimit(adminId, "admin-images", 60, 60_000);
    if (limited) return fail(limited);
    const url = new URL(req.url);
    const userId = queryText(url.searchParams.get("userId"), 40) ?? undefined;
    // Paginated (pass 43). The list was hard-coded to the newest 50 with no
    // page parameter, so a reported image fell permanently out of the console's
    // reach once 50 newer ones existed — and DELETE takes an id the operator
    // could no longer obtain. `total` tells the console whether older rows
    // exist; the page is clamped and echoed back, so a stale number left behind
    // by deletions cannot point the view past the end.
    const pageSize = 50;
    const parsedPage = Number(queryText(url.searchParams.get("page"), 10) ?? "1");
    const requestedPage = Number.isFinite(parsedPage) && parsedPage >= 1 ? Math.floor(parsedPage) : 1;
    const where = userId ? { userId } : undefined;
    const total = await prisma.image.count({ where });
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
    const images = await prisma.image.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, userId: true, url: true, model: true, prompt: true, createdAt: true },
    });
    return ok({ images, total, page, pageSize });
  } catch (e) {
    return fail(e);
  }
}
