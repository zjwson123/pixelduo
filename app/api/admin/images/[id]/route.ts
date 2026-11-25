import { NextResponse } from "next/server";
import { ADMIN_TX_OPTIONS, assertAdminActorTx, requireAdmin, requireAdminSession } from "@/lib/admin";
import { ok, fail, enforceUserRateLimit, refuseNul, errorResponse } from "@/lib/api";
import { prisma } from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { contentTypeFromKey, sniffContentType } from "@/lib/media-type";
import { acquireFileStreamSlot, createGuardedBody } from "@/lib/stream-limit";
import { getModel } from "@/lib/model-registry";

// Preview one image for moderation. The admin console used to list id/user/
// model/prompt without rendering the image, and /api/files only authorizes its
// OWNER (or a template), so an operator could neither see what a report was
// about nor inspect what a Delete button would remove. This route answers the
// same bytes to an admin, never caches them, and is rate-limited per operator.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let releaseSlot: (() => void) | null = null;
  try {
    refuseNul(id);
    const adminId = await requireAdmin();
    const limited = await enforceUserRateLimit(adminId, "admin-image-preview", 120, 60_000);
    if (limited) return fail(limited);
    const image = await prisma.image.findUnique({ where: { id: id }, select: { url: true, model: true } });
    if (!image) return fail(new Error("image-not-found"));
    // The console renders one preview per row, 50 rows a page. `Image` rows
    // include video outputs (the worker completes a video with model seedance),
    // so a moderation page used to open 50 full-object streams — up to 50 × the
    // 100 MB video cap through the web process and the operator's browser — for
    // thumbnails that cannot even render a video as <img>. Videos are now
    // opt-in through ?full=1 (the row offers an explicit "open" link); the
    // automatic grid never streams one. Images keep the inline preview.
    const isVideo = getModel(image.model)?.mediaType === "video";
    if (isVideo && new URL(req.url).searchParams.get("full") !== "1") {
      return errorResponse({ ok: false, error: "preview-not-image" }, { status: 415 });
    }
    // HEAD must not open a storage body either. Next auto-implements HEAD by
    // calling this GET and then discarding the body, so the stream slot and the
    // S3 socket were held until the idle deadline while nothing ever read them
    // (the same pool-exhaustion shape /api/files fixed in pass 51). Metadata
    // only: an admin re-check is pointless for an object this route will never
    // serve as a body.
    if (req.method === "HEAD") {
      // Metadata still occupies an S3 socket (HeadObject), and this branch was
      // the one storage operation left outside the per-owner stream cap after
      // pass 65 closed it for /api/files (pass 70). 120 concurrent HEADs from a
      // stolen admin session (the limiter counts requests, not concurrency)
      // could pin the shared 192-socket pool alongside two ordinary accounts'
      // 128 slots, stalling every tenant's media and the storage health probe.
      const acquired = acquireFileStreamSlot(`admin:${adminId}`);
      if (!acquired) {
        return errorResponse(
          { ok: false, error: "too-many-streams" },
          { status: 429, headers: { "Retry-After": "5" } },
        );
      }
      releaseSlot = acquired;
      const size = (await getStorage().size(image.url)) ?? undefined;
      releaseSlot();
      releaseSlot = null;
      if (size === undefined) return fail(new Error("image-not-found"));
      const headHeaders: Record<string, string> = {
        "Content-Type": contentTypeFromKey(image.url) ?? "application/octet-stream",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Length": String(size),
      };
      return new NextResponse(null, { status: 200, headers: headHeaders });
    }
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
    // The same concurrency ceiling as /api/files (pass 47): the preview
    // streams a delivered object (a video can be up to 100 MB) and a stolen
    // admin session could otherwise open responses and never read them until
    // the web process runs out of descriptors. The console only needs a page of
    // thumbnails at a time, far below the per-owner cap.
    const acquired = acquireFileStreamSlot(`admin:${adminId}`);
    if (!acquired) {
      return errorResponse(
        { ok: false, error: "too-many-streams" },
        { status: 429, headers: { "Retry-After": "5" } },
      );
    }
    releaseSlot = acquired;
    const streamed = await getStorage().getStream(image.url);
    if (!streamed) {
      releaseSlot();
      releaseSlot = null;
      return fail(new Error("image-not-found"));
    }
    const reader = streamed.stream.getReader();
    const first = await reader.read();
    const head = first.done ? new Uint8Array(0) : first.value!;
    const body = createGuardedBody(reader, head, acquired);
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
    releaseSlot?.();
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
    const actor = await requireAdminSession();
    const adminId = actor.id;
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
    //
    // Authority is re-proven immediately before the irreversible half (pass
    // 62): the gate at the top of the request can be superseded while the
    // lookup above runs, and a blob delete cannot be rolled back by the
    // transaction-based re-check the other admin writes use.
    await assertAdminActorTx(prisma, actor);
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
    //
    // The commit-time re-check is in the SAME transaction as the row delete
    // (pass 63): the pass-62 check above runs before the storage round trip,
    // and an erasure/revocation of this operator that commits during that
    // round trip would otherwise still let the takedown be recorded under an
    // actor who was no longer authorized. The blob is already gone by then;
    // the row is what carries the operator's name, and it now rolls back so a
    // still-authorized operator can re-run the takedown.
    // Same wait as the role/credits routes (pass 66): the re-proof blocks on a
    // User row that an in-flight erasure of the ACTOR may hold for up to 60s.
    // Prisma's 5s default turned that documented wait into P2028 — a masked 500
    // and an incident — after the blob had already been deleted.
    const gone = await prisma.$transaction(async (tx) => {
      await assertAdminActorTx(tx, actor);
      return tx.image.deleteMany({ where: { id: image.id } });
    }, ADMIN_TX_OPTIONS);
    if (gone.count === 0) return fail(new Error("image-not-found"));
    return ok({ deleted: true });
  } catch (e) {
    return fail(e);
  }
}
