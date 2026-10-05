import { requireAdmin } from "@/lib/admin";
import { ok, fail, enforceUserRateLimit, refuseNul } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { getStorage } from "@/lib/storage";

// Remove a generated image (moderation / ToS removal). Delivered content is
// not refunded — credit refunds are handled separately via user credits.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    // %00 → U+0000 → SQLSTATE 22021 → masked 500 + captured incident; the
    // sibling leg of pass 25's body/query NUL guards.
    refuseNul(id);
    const adminId = await requireAdmin();
    const limited = await enforceUserRateLimit(adminId, "admin-image-delete", 60, 60_000);
    if (limited) return fail(limited);
    const image = await prisma.image.findUnique({ where: { id: id } });
    if (!image) return fail(new Error("image-not-found"));
    await getStorage().delete(image.url).catch(() => undefined);
    await prisma.image.delete({ where: { id: image.id } });
    return ok({ deleted: true });
  } catch (e) {
    return fail(e);
  }
}
