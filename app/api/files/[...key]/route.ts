import { requireUserId, ApiError, enforceRateLimit } from "@/lib/api";
import { authenticateApiKey } from "@/lib/apikey";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { sniffContentType, contentTypeFromKey } from "@/lib/media-type";

// Error bodies need the same no-store as the success path, for the reason
// lib/api.ts centralises it: a 401/403/404 for a URL-addressable resource is
// heuristically cacheable, so a shared cache in front of /api/* can pin one
// user's error for every later visitor to that exact key. It is reachable by
// design here — /api/jobs hands out /api/files/<key> URLs for images that are
// merely checkpointed, so a client following them immediately gets a 404 for a
// path that starts serving 200 seconds later.
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/**
 * Parse a single-range `Range: bytes=…` request against a known object size.
 *
 * Returns "ignore" for anything we do not support (no header, a multi-range
 * request, an unparseable value) — the caller then answers 200 with the whole
 * object, which is always a valid response. Returns "unsatisfiable" for a range
 * that lies outside the object, which must be a 416 per RFC 9110 §14.2 (a
 * browser sends it after a stale seek; answering 200 restarts the download and
 * 404 hides a perfectly good file).
 */
function parseRange(
  header: string | null,
  total: number,
): { start: number; end: number } | "ignore" | "unsatisfiable" {
  if (!header) return "ignore";
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return "ignore"; // multi-range or a unit we do not serve
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return "ignore";
  if (total <= 0) return "unsatisfiable";
  let start: number;
  let end: number;
  if (rawStart === "") {
    // Suffix range: the LAST n bytes.
    const n = Number(rawEnd);
    if (n <= 0) return "unsatisfiable";
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? total - 1 : Math.min(Number(rawEnd), total - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "ignore";
  if (start >= total || start > end) return "unsatisfiable";
  return { start, end };
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

  // Streaming the object: the old full-buffer get() materialized up to 100 MB
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
  //
  // Range support (RFC 9110 §14.2): every `<video>` element asks for one, and a
  // 200 with no Accept-Ranges is what makes the clip non-seekable — Safari
  // refuses to play such a source at all, and an interrupted download restarts
  // from zero. Only when the client asked for one do we pay for the extra size
  // lookup, so the ordinary image/thumbnail path is unchanged.
  const rangeHeader = req.headers.get("range");
  let range: { start: number; end: number } | null = null;
  let total: number | undefined;
  if (rangeHeader) {
    total = (await getStorage().size(key)) ?? undefined;
    if (total === undefined) return new NextResponse("not found", { status: 404, headers: NO_STORE });
    const parsed = parseRange(rangeHeader, total);
    if (parsed === "unsatisfiable") {
      return new NextResponse("range not satisfiable", {
        status: 416,
        headers: { ...NO_STORE, "Content-Range": `bytes */${total}`, "Accept-Ranges": "bytes" },
      });
    }
    if (parsed !== "ignore") range = parsed;
  }

  const obj = await getStorage().getStream(key, range ?? undefined);
  if (!obj) return new NextResponse("not found", { status: 404, headers: NO_STORE });
  const reader = obj.stream.getReader();
  const first = await reader.read();
  const head = first.done ? new Uint8Array(0) : first.value!;

  const download = new URL(req.url).searchParams.get("download") === "1";
  // Sanitize filename to prevent header injection (CR/LF, quotes, path traversal).
  const rawName = key.split("/").pop() || "image";
  const baseName = rawName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "image";
  // Magic bytes are only meaningful at the start of the OBJECT, not of a range.
  const sniffed = range && range.start > 0 ? null : sniffContentType(head);
  const resolvedTotal = obj.total ?? total;
  const headers: Record<string, string> = {
    "Content-Type": sniffed ?? contentTypeFromKey(key) ?? "application/octet-stream",
    // Authorization is re-evaluated on EVERY request, so the response must not
    // tell the browser to reuse the bytes for a year without asking again:
    // on a shared browser profile, media fetched by one session was served
    // from cache to a later, different session. Templates are the same file
    // for every user, so they keep the long immutable cache (that is what
    // keeps Explore fast); user-owned media is revalidated instead.
    "Cache-Control": shared ? "private, max-age=31536000, immutable" : "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
  };
  if (range && resolvedTotal !== undefined) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${resolvedTotal}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
  } else if (obj.length !== undefined) {
    headers["Content-Length"] = String(obj.length);
  }
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
    // 206 only when the bytes really are a slice: a range we chose to ignore
    // (a multi-range request) is answered with the whole object as a 200.
    status: range ? 206 : 200,
    headers,
  });
}
