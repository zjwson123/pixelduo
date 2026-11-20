import { requireUserId, ApiError, enforceRateLimit, enforceUserRateLimit, fail, refuseNul, errorResponse } from "@/lib/api";
import { authenticateApiKey } from "@/lib/apikey";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { sniffContentType, contentTypeFromKey } from "@/lib/media-type";
import { acquireFileStreamSlot, createGuardedBody } from "@/lib/stream-limit";
import type { StorageStream } from "@/lib/storage";

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
  const { key: keyParts } = await params;
  const key = keyParts.join("/");
  // The key is compared against Image.url / Template.img and then handed to the
  // storage driver, so a NUL in it is a Postgres 22021 — a masked 500 plus a
  // captured incident, reachable without a credential (`/api/files/img/x%00.png`
  // answered 500 for anyone). Refused as the client error it is.
  //
  // The refusal must be mapped HERE: refuseNul throws an ApiError, this
  // handler's other try blocks all start below (the session read, the stream
  // pull), and an escaping throw is Next's uncaught-error path — an anonymous
  // request got the same 500 the guard exists to remove, one Sentry event per
  // request (the @sentry/nextjs route wrapper captures handled:false), and the
  // route's own limiters below were never reached. fail() maps it to 400 and
  // stamps the no-store every other response here carries.
  try {
    refuseNul(key);
  } catch (e) {
    return fail(e);
  }
  // A key is a storage key ("img/<uuid>.png"), never an absolute path. A
  // percent-encoded leading slash (`%2Ftemplates/x.png`) decoded into one and
  // matched a seeded Template.img (stored as "/templates/x.png" for the PUBLIC
  // asset), while the storage driver strips the slash and reads a different
  // object — a lookup/storage disagreement that would serve any bucket object
  // sitting at the relative key to every signed-in user (pass 62). Refuse the
  // shape instead of guessing which half was meant.
  if (!key || key.startsWith("/")) {
    return new NextResponse("not found", { status: 404, headers: NO_STORE });
  }
  // requireUserId (not raw getServerSession) so a partial 2FA session or a
  // stale JWT revoked via sessionVersion can't read files. Bearer API keys
  // authenticate too — v1 API responses under the local storage driver hand
  // out /api/files URLs, which machine clients (no cookies) otherwise can't
  // fetch; ownership scoping below applies identically to either credential.
  //
  // Resolved BEFORE the charge, and the charge lands on the dimension that can
  // be held responsible — the same rule /api/feedback and every other
  // authenticated route already follows. This route kept a single bucket keyed
  // on the source address, and it is the route every image and video in the UI
  // flows through: a gallery or Explore page is dozens of requests, so two
  // accounts behind one egress (an office, a VPN, a carrier NAT) spent one
  // 600/min budget between them and the images simply stopped loading for both
  // — with no account, no cookie and no knowledge of the victims required,
  // since the bucket was charged before any credential was looked at. That is
  // the shape passes 18/20/21 removed from the other authenticated routes; this
  // one was left behind.
  let uid: string | null = null;
  let sessionError: ApiError | null = null;
  try {
    uid = await requireUserId();
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    sessionError = e;
  }

  if (uid) {
    // Objects are the largest payloads in the system (videos up to 100 MB);
    // without a per-account cap a single user concurrent-fetching their own
    // videos in a loop is a self-service heap/bandwidth pump. 600/min keeps
    // gallery browsing (dozens of images per page) far below the ceiling.
    const limited = await enforceUserRateLimit(uid, "files", 600, 60_000);
    if (limited) return fail(limited);
  } else {
    // No session: an anonymous caller has no credential to key on and must
    // still be bounded before the API-key lookup and the image/template
    // queries below, so the source address is the only dimension there is.
    const limited = await enforceRateLimit(req, "files", 600, 60_000);
    if (limited) return limited;
    const apiKey = await authenticateApiKey(req);
    if (!apiKey) {
      const status = sessionError?.status ?? 401;
      return new NextResponse(sessionError?.message ?? "unauthorized", { status, headers: NO_STORE });
    }
    if (!apiKey.emailVerified) {
      return new NextResponse("email not verified", { status: 403, headers: NO_STORE });
    }
    // The credential resolved, so the account leg applies to bearer clients
    // exactly as it does to sessions and to the v1 family (which charges the IP
    // leg AND the key leg). Without it the IP bucket above was this route's
    // ONLY charge for a machine client: the addresses are shared and spent
    // BEFORE any credential is examined, so 600 anonymous requests/minute from
    // one egress answered a paying API customer's own image/video fetches with
    // 429 for the rest of the window — a bearer client fetching its own 100 MB
    // videos had no per-account ceiling at all, and rotating addresses removed
    // even the IP one. The IP leg stays as the pre-auth flood bound.
    const keyLimited = await enforceUserRateLimit(apiKey.userId, "files", 600, 60_000);
    if (keyLimited) return fail(keyLimited);
    uid = apiKey.userId;
  }

  // Everything from here to the first chunk is storage/DB work OUTSIDE any
  // handler-level mapping (pass 32): an unexpected throw — a database fault on
  // the route every image and video in the UI flows through, or, under the
  // local driver, a delete landing between getStream()'s lazy open and the
  // first read (ENOENT) — escaped as Next's bare unmasked 500 and one
  // handled:false Sentry event per request, the exact shape the refuseNul
  // guard above exists to remove. fail() maps an ApiError to its status and
  // anything else to the masked internal-error, with captureError attached.
  let shared = false;
  const download = new URL(req.url).searchParams.get("download") === "1";
  // Definite-assignment assertions: the catch below returns, so every path
  // that reaches the streaming code has run the whole try.
  let obj!: StorageStream;
  let reader!: ReadableStreamDefaultReader<Uint8Array>;
  let head!: Uint8Array;
  // The concurrency slot is acquired just before the storage handle is opened
  // and handed to the response body, which releases it on completion, cancel,
  // read error or the idle deadline. Any path that does not hand it over must
  // release it here or in the catch.
  // A state object rather than a bare `let`: TypeScript's control-flow
  // analysis cannot see an assignment made inside a closure and would narrow a
  // bare binding to `null` at its call sites (`never` on the release call).
  const heldSlot: { release: (() => void) | null } = { release: null };
  const releaseHeldSlot = (): void => {
    const release = heldSlot.release;
    heldSlot.release = null;
    release?.();
  };
  let slot!: () => void;
  let range: { start: number; end: number } | null = null;
  let total: number | undefined;
  // Both credential branches above assign uid, but a mutable binding is not
  // narrowed inside a callback; capture the non-null owner once for the helper.
  const owner = uid as string;
  // One slot for EVERY storage operation below, metadata included (pass 65).
  //
  // HEAD and the Range size lookup used to run before this point, so a single
  // account could issue 300 concurrent HEADs (or Range requests that all did
  // the size call before the 64-slot per-owner cap refused them) and queue 300
  // HeadObjects on the shared S3 agent — 192 sockets, 30s request timeout.
  // That is exactly the pool-pinning outage pass 47/52 closed for bodies; the
  // metadata half was left outside the cap. A refusal is the same retryable
  // 429, before any storage call.
  const takeStreamSlot = (): NextResponse | null => {
    if (heldSlot.release) return null;
    const acquired = acquireFileStreamSlot(owner);
    if (!acquired) {
      return errorResponse(
        { ok: false, error: "too-many-streams" },
        { status: 429, headers: { "Retry-After": "5" } },
      );
    }
    heldSlot.release = acquired;
    slot = acquired;
    return null;
  };
  try {
    // 1. User-owned generated image/video
    const image = await prisma.image.findFirst({ where: { userId: uid, url: key } });
    // 2. Shared template image (Explore gallery) — any logged-in user
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
    if (rangeHeader) {
      const denied = takeStreamSlot();
      if (denied) return denied;
      total = (await getStorage().size(key)) ?? undefined;
      if (total === undefined) {
        releaseHeldSlot();
        return new NextResponse("not found", { status: 404, headers: NO_STORE });
      }
      const parsed = parseRange(rangeHeader, total);
      if (parsed === "unsatisfiable") {
        releaseHeldSlot();
        return new NextResponse("range not satisfiable", {
          status: 416,
          headers: { ...NO_STORE, "Content-Range": `bytes */${total}`, "Accept-Ranges": "bytes" },
        });
      }
      if (parsed !== "ignore") range = parsed;
    }

    // HEAD must not open a storage body. Next implements HEAD by calling this
    // GET export and then DISCARDING the body (send-response ends the response
    // without touching it), so before this branch a HEAD acquired a stream slot
    // and an S3 GetObject whose reader nobody ever pulled: the response ended,
    // the guarded body was never consumed, and the slot plus the S3 socket sat
    // parked until the 120s idle deadline. The S3 client's default pool is 50
    // sockets, and the per-owner stream cap is 128 — 51 HEADs from ONE ordinary
    // account (its own gallery key, or a Template.img key listed by
    // /api/templates) pinned the whole pool: every media GET timed out and
    // /api/health's storage probe answered 503, so the container was reported
    // unhealthy for every tenant. Metadata only, no BODY: the size is the one
    // already fetched for a Range request, or a single HeadObject — but the
    // metadata call itself still occupies an S3 socket, so it takes the same
    // slot as a stream (pass 65) and gives it back before the response.
    if (req.method === "HEAD") {
      const denied = takeStreamSlot();
      if (denied) return denied;
      const size = total ?? (await getStorage().size(key)) ?? undefined;
      releaseHeldSlot();
      if (size === undefined) return new NextResponse("not found", { status: 404, headers: NO_STORE });
      const headHeaders: Record<string, string> = {
        // Extension-derived: sniffing needs the bytes, and reading the first
        // chunk is exactly the upstream handle this branch exists not to open.
        "Content-Type": contentTypeFromKey(key) ?? "application/octet-stream",
        "Cache-Control": shared ? "private, max-age=31536000, immutable" : "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Accept-Ranges": "bytes",
      };
      if (range) {
        headHeaders["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
        headHeaders["Content-Length"] = String(range.end - range.start + 1);
      } else {
        headHeaders["Content-Length"] = String(size);
      }
      if (download) {
        const rawName = key.split("/").pop() || "image";
        const baseName = rawName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "image";
        headHeaders["Content-Disposition"] = `attachment; filename="${baseName}"`;
      }
      return new NextResponse(null, { status: range ? 206 : 200, headers: headHeaders });
    }

    // Bound concurrent streams BEFORE the object is opened (pass 47). Every
    // response below holds a storage handle (a local fd or an S3 socket) and a
    // client socket until the consumer finishes, cancels, or the idle deadline
    // fires — the rate limiters count requests per minute, not streams in
    // flight, so an account that sends requests and never reads the bodies
    // could hold both until the process runs out of descriptors. The slot is
    // per account and per process; a refusal is a retryable 429 before any
    // storage work happens. A Range request already holds one from the size
    // lookup above, so takeStreamSlot() is a no-op there.
    const denied = takeStreamSlot();
    if (denied) return denied;
    const streamed = await getStorage().getStream(key, range ?? undefined);
    if (!streamed) {
      releaseHeldSlot();
      return new NextResponse("not found", { status: 404, headers: NO_STORE });
    }
    obj = streamed;
    reader = obj.stream.getReader();
    const first = await reader.read();
    head = first.done ? new Uint8Array(0) : first.value!;
  } catch (e) {
    releaseHeldSlot();
    return fail(e);
  }

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

  // The guarded body replays the sniffed first chunk, releases the concurrency
  // slot exactly once (completion, cancel, read error, or an idle deadline that
  // retires a stream nobody is consuming), and cancels the upstream handle.
  const body = createGuardedBody(reader, head, slot);

  return new NextResponse(body, {
    // 206 only when the bytes really are a slice: a range we chose to ignore
    // (a multi-range request) is answered with the whole object as a 200.
    status: range ? 206 : 200,
    headers,
  });
}
