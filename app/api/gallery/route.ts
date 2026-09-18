import { z } from "zod";
import { requireUserId, ok, fail, enforceRateLimit, enforceUserRateLimit, readBodyCapped, zodMessage } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { serveUserUrl } from "@/lib/store";
import { getStorage } from "@/lib/storage";

export async function GET() {
  try {
    const userId = await requireUserId();
    const rows = await prisma.image.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 60,
    });
    const served = rows.map((i) => ({ ...i, url: serveUserUrl(i.url) }));
    return ok({ images: served });
  } catch (e) {
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
