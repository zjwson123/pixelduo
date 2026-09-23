import { z } from "zod";
import { requireUserId, ok, fail, enforceRateLimit, enforceUserRateLimit, readBodyCapped, zodMessage } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { serveUserUrl } from "@/lib/store";
import { getStorage } from "@/lib/storage";
import { getAllModels } from "@/lib/model-registry";

const listSchema = z.object({
  type: z.enum(["all", "image", "video"]).default("all"),
  sort: z.enum(["newest", "oldest"]).default("newest"),
});

export async function GET(req: Request) {
  try {
    const userId = await requireUserId();
    // Per-ACCOUNT, like every sibling read (jobs 600/min, templates 60/min):
    // the middleware's per-IP cap is per-instance and IP rotation lifts it, and
    // this is the most expensive list in the app (a page of rows joined to
    // their job). 120/min is far above any real browsing cadence.
    const limited = await enforceUserRateLimit(userId, "gallery-list", 120, 60_000);
    if (limited) return fail(limited);
    const params = new URL(req.url).searchParams;
    const { type, sort } = listSchema.parse({ type: params.get("type") ?? undefined, sort: params.get("sort") ?? undefined });
    // Registry-derived, including disabled models: history keeps rows from
    // models that have since been turned off. Unknown legacy model ids fall
    // into "image" (notIn), which keeps them visible under the default view.
    const videoModelIds = getAllModels().filter((m) => m.mediaType === "video").map((m) => m.id);
    const rows = await prisma.image.findMany({
      where: {
        userId,
        ...(type === "video"
          ? { model: { in: videoModelIds } }
          : type === "image"
            ? { model: { notIn: videoModelIds } }
            : {}),
      },
      orderBy: { createdAt: sort === "oldest" ? "asc" : "desc" },
      take: 60,
    });
    const served = rows.map((i) => ({ ...i, url: serveUserUrl(i.url) }));
    return ok({ images: served });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}

const deleteSchema = z.object({
  // Mirrors GET's take:60 — the client can only select what it was shown.
  ids: z.array(z.string().min(1).max(64)).min(1).max(60),
});

export async function DELETE(req: Request) {
  try {
    const userId = await requireUserId();
    const limited = await enforceRateLimit(req, "gallery-delete", 10, 60_000);
    if (limited) return limited;
    const userLimited = await enforceUserRateLimit(userId, "gallery-delete", 10, 60_000);
    if (userLimited) return fail(userLimited);
    const bodyRaw = await readBodyCapped(req, 16 * 1024);
    if ("tooLarge" in bodyRaw) return new Response("payload too large", { status: 413 });
    const { ids } = deleteSchema.parse(JSON.parse(bodyRaw.raw));

    // Ownership lives in the where-clause itself: ids belonging to another
    // user are simply not matched, so the response leaks nothing.
    const owned = await prisma.image.findMany({
      where: { id: { in: ids }, userId },
      select: { id: true, url: true },
    });
    const del = await prisma.image.deleteMany({
      where: { id: { in: owned.map((r) => r.id) }, userId },
    });
    // Blob cleanup is best-effort: the row is what makes content visible, so
    // a failed storage delete must not fail the request (orphaned blobs are
    // an ops concern, not a user-facing one).
    await Promise.all(owned.map((r) => getStorage().delete(r.url).catch(() => undefined)));
    return ok({ deleted: del.count });
  } catch (e) {
    if (e instanceof z.ZodError) return fail(zodMessage(e));
    return fail(e);
  }
}
