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
    // Blob first (the original order): a crash between the two leaves a row
    // pointing at a missing object, which the admin simply re-runs and heals —
    // the reverse order leaks the blob with nothing left to name it.
    await getStorage().delete(image.url).catch(() => undefined);
    // The row delete is a CAS on the id, not `delete()` (pass 38). The read
    // above and the storage round trip between it and the delete leave a wide
    // window: two concurrent takedowns (a double-clicked console button, two
    // tabs) both pass the check, and the loser's `delete()` raises P2025 —
    // whose message starts with "Invalid `prisma…`" so no expectedStatus
    // branch matches it — a masked 500 plus a captured incident for an action
    // that in fact succeeded. The three siblings this pass compared against
    // (admin/feedback/[id], admin/users/[id], gallery DELETE) all use a
    // predicate-carrying deleteMany for exactly this; probed, the pre-fix
    // shape answered 200-then-500 on 6 of 6 rounds.
    const gone = await prisma.image.deleteMany({ where: { id: image.id } });
    if (gone.count === 0) return fail(new Error("image-not-found"));
    return ok({ deleted: true });
  } catch (e) {
    return fail(e);
  }
}
