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
    const take = 50;
    const images = await prisma.image.findMany({
      where: userId ? { userId } : undefined,
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, userId: true, url: true, model: true, prompt: true, createdAt: true },
    });
    return ok({ images });
  } catch (e) {
    return fail(e);
  }
}
