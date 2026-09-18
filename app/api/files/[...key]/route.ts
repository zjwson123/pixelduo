import { requireUserId, ApiError, enforceRateLimit } from "@/lib/api";
import { authenticateApiKey } from "@/lib/apikey";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getStorage } from "@/lib/storage";

// Error bodies need the same no-store as the success path, for the reason
// lib/api.ts centralises it: a 401/403/404 for a URL-addressable resource is
// heuristically cacheable, so a shared cache in front of /api/* can pin one
// user's error for every later visitor to that exact key. It is reachable by
// design here — /api/jobs hands out /api/files/<key> URLs for images that are
// merely checkpointed, so a client following them immediately gets a 404 for a
// path that starts serving 200 seconds later.
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function sniffContentType(buf: Uint8Array): string {
  // Video: MP4
  if (
    buf.length >= 12 &&
    buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70 &&
    buf[8] === 0x69 && buf[9] === 0x73 && buf[10] === 0x6f && buf[11] === 0x6d
  ) {
    return "video/mp4";
  }
  // Video: WebM
  if (
    buf.length >= 4 &&
    buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3
  ) {
    return "video/webm";
  }
  // Image: JPEG
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // Image: PNG
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  // Image: WebP (RIFF....WEBP)
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return "application/octet-stream";
}

// Authenticated, ownership-scoped image/video serving.
// Template images (from the Explore gallery) are shared across all users —
// any logged-in user can fetch them by key, but the key must exist in the
// Template table so arbitrary file enumeration is impossible.
export async function GET(req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  // Objects are the largest payloads in the system (videos up to 100 MB);
  // without a per-IP cap a single user concurrent-fetching their own videos
  // in a loop is a self-service heap/bandwidth pump. 600/min keeps gallery
  // browsing (dozens of images per page) far below the ceiling.
  const limited = await enforceRateLimit(req, "files", 600, 60_000);
  if (limited) return limited;
  const { key: keyParts } = await params;
  const key = keyParts.join("/");
  // requireUserId (not raw getServerSession) so a partial 2FA session or a
  // stale JWT revoked via sessionVersion can't read files. Bearer API keys
  // authenticate too — v1 API responses under the local storage driver hand
  // out /api/files URLs, which machine clients (no cookies) otherwise can't
  // fetch; ownership scoping below applies identically to either credential.
  let uid: string;
  try {
    uid = await requireUserId();
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const apiKey = await authenticateApiKey(req);
    if (!apiKey) return new NextResponse(e.message, { status: e.status, headers: NO_STORE });
    if (!apiKey.emailVerified) {
      return new NextResponse("email not verified", { status: 403, headers: NO_STORE });
    }
    uid = apiKey.userId;
  }

  // 1. User-owned generated image/video
  const image = await prisma.image.findFirst({ where: { userId: uid, url: key } });
  // 2. Shared template image (Explore gallery) — any logged-in user
  let shared = false;
  if (!image) {
    const template = await prisma.template.findFirst({ where: { img: key }, select: { id: true } });
    if (!template) return new NextResponse("not found", { status: 404, headers: NO_STORE });
    shared = true;
  }

  // Stream the object: the old full-buffer get() materialized up to 100 MB
  // per request in heap. Pull the first chunk to sniff the content type from
  // magic bytes, then replay it ahead of the rest of the stream.
  //
  // The consumer drives the read (pull, one chunk per call). A `start()` loop
  // that enqueues every chunk as fast as the reader produces them is NOT a
  // streaming fix: controller.enqueue never blocks, so the whole object sits in
  // the stream's internal queue within milliseconds of the response being
  // created — the same N × object-size heap as the get() it replaced, held
  // until the socket drains (Node's requestTimeout caps that at 300s). ~100
  // concurrent slow reads of 2-5 MB objects is a 512 MB container's OOM.
  const obj = await getStorage().getStream(key);
  if (!obj) return new NextResponse("not found", { status: 404, headers: NO_STORE });
  const reader = obj.stream.getReader();
  const first = await reader.read();
  const head = first.done ? new Uint8Array(0) : first.value!;

  const download = new URL(req.url).searchParams.get("download") === "1";
  // Sanitize filename to prevent header injection (CR/LF, quotes, path traversal).
  const rawName = key.split("/").pop() || "image";
  const baseName = rawName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "image";
  const headers: Record<string, string> = {
    "Content-Type": sniffContentType(head),
    // Authorization is re-evaluated on EVERY request, so the response must not
    // tell the browser to reuse the bytes for a year without asking again:
    // on a shared browser profile, media fetched by one session was served
    // from cache to a later, different session. Templates are the same file
    // for every user, so they keep the long immutable cache (that is what
    // keeps Explore fast); user-owned media is revalidated instead.
    "Cache-Control": shared ? "private, max-age=31536000, immutable" : "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (obj.length !== undefined) headers["Content-Length"] = String(obj.length);
  if (download) {
    headers["Content-Disposition"] = `attachment; filename="${baseName}"`;
  }

  let headSent = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // The sniffed first chunk is replayed first; every later pull hands out
        // exactly one chunk, so at most one chunk plus the socket's own buffer
        // is ever resident.
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
    headers,
  });
}
