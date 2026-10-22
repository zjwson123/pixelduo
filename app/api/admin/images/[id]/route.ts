import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { ok, fail, enforceUserRateLimit, refuseNul } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { contentTypeFromKey, sniffContentType } from "@/lib/media-type";

// Preview one image for moderation. The admin console used to list id/user/
// model/prompt without rendering the image, and /api/files only authorizes its
// OWNER (or a template), so an operator could neither see what a report was
// about nor inspect what a Delete button would remove. This route answers the
// same bytes to an admin, never caches them, and is rate-limited per operator.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    refuseNul(id);
    const adminId = await requireAdmin();
    const limited = await enforceUserRateLimit(adminId, "admin-image-preview", 120, 60_000);
    if (limited) return fail(limited);
    const image = await prisma.image.findUnique({ where: { id: id }, select: { url: true } });
    if (!image) return fail(new Error("image-not-found"));
    // Streamed, not buffered (pass 44). `Image` rows include VIDEO outputs
    // (the worker completes a video with model seedance), so one preview used
    // to materialize up to the 100 MB download cap in the web process — twice,
    // because a Buffer was copied into a Uint8Array view — and the console
    // renders the page's whole page of thumbnails at once. 120/min of that is
    // an OOM of the container serving every user, reachable by a stolen admin
    // session. /api/files solved the same problem for user media with the
    // driver's stream; this is the admin equivalent.
    //
    // The first chunk is pulled only to sniff the Content-Type from the bytes
    // (a mid-file preview is not a thing here — there is no Range support), and
    // is replayed ahead of the rest by the consumer-driven stream below.
    const streamed = await getStorage().getStream(image.url);
    if (!streamed) return fail(new Error("image-not-found"));
    const reader = streamed.stream.getReader();
    const first = await reader.read();
    const head = first.done ? new Uint8Array(0) : first.value!;
    let headSent = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (!headSent) {
            headSent = true;
            if (head.byteLength > 0) {
              controller.enqueue(head);
              return;
            }
          }
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (value) controller.enqueue(value);
        } catch (e) {
          controller.error(e);
        }
      },
      cancel() {
        reader.cancel().catch(() => undefined);
      },
    });
    return new NextResponse(body, {
      headers: {
        "Content-Type": sniffContentType(head) ?? contentTypeFromKey(image.url) ?? "application/octet-stream",
        // Moderation content must never be reused from a shared admin browser's
        // cache after a takedown.
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        ...(streamed.length !== undefined ? { "Content-Length": String(streamed.length) } : {}),
      },
    });
  } catch (e) {
    return fail(e);
  }
}

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
    //
    // A storage failure must FAIL the request, not be swallowed (pass 41). The
    // drivers reject on every real error (EACCES/ENOSPC, an S3 permission or
    // network fault) and treat a missing key as success, exactly like erasure;
    // swallowing the throw deleted the only row naming the object and answered
    // `{deleted:true}`, so a moderation takedown was recorded as done while the
    // blob stayed live (reachable by any still-valid presigned URL) and no
    // re-run could find it — the row was already gone. fail() reports it and
    // the row survives, so the admin can retry.
    await getStorage().delete(image.url);
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
