// Bounds on storage-backed response streams.
//
// /api/files is the route every image and video in the UI flows through, and
// its streaming design bounds the memory ONE response holds (a consumer-driven
// pull, one chunk at a time — see the route). It did not bound how many
// responses can be in flight at once, and a stream is a RESOURCE even when it
// is not using heap: the route opens the storage object before returning (a
// local file descriptor, or an S3 response holding a socket) and keeps it open
// until the consumer either finishes or cancels. A client that sends requests
// and never reads the body keeps both the upstream handle and its own socket
// parked; Node's request timeout covers receiving a request, not writing the
// response, so nothing else ends them.
//
// The rate limiters are counts per minute, not concurrency: one account could
// hold 300 new streams a minute (and more accounts multiply that) until the
// process hits its descriptor limit and every user's image, video, login and
// API request fails. This module adds the two bounds the route was missing —
// a concurrent-stream ceiling (per account and per process) and an idle
// deadline that retires a stream nobody is reading — and wraps the existing
// reader with the replay/idle logic so /api/files keeps its current shape.
//
// A refusal shed BEFORE the object is opened: the caller gets a 429 with a
// Retry-After, which is the honest answer for "the server is holding as many
// streams as it will" and is recoverable (a browser retries image loads).

// The ceilings and the S3 client's socket pool have to agree (pass 52). The
// SDK's NodeHttpHandler defaults to maxSockets = 50 for the WHOLE client, and
// every stream holds one socket from that pool until its consumer finishes or
// the idle deadline fires. The old per-owner cap of 128 therefore sat ABOVE the
// resource it was meant to protect: one ordinary account opening 51 GETs on
// its own gallery key (the HEAD half was fixed in pass 51; the GET path still
// opens the object) and never reading the bodies pinned the entire pool — every
// other user's media hung and /api/health's storage probe answered 503 for the
// whole deployment. lib/storage supplies an explicit agent sized above the
// per-process ceiling (S3_MAX_SOCKETS, 192), so the caps below — not an SDK
// default — are what binds.
//
// The per-owner ceiling has to fit ONE legitimately rendered page. /api/gallery
// returns 60 rows and the grid renders all 60 <img> tags, and Caddy terminates
// TLS with HTTP/2 — so the browser may hold far more than six requests for the
// same origin at once. 32 made the 33rd thumbnail a 429 that the browser does
// not retry. 64 covers a full gallery page with headroom, and still leaves at
// least 128 of the 192 sockets to every other tenant, the HEAD/health probes
// and uploads even when that owner is also a deliberate stream-parker.
export const MAX_CONCURRENT_FILE_STREAMS = 128;
export const MAX_CONCURRENT_FILE_STREAMS_PER_OWNER = 64;

// How long a response may go without the consumer pulling another chunk before
// it is assumed abandoned. A legitimate client reads continuously (the pauses
// are TCP backpressure, not minutes), and a video element that is paused may
// stop reading for a while — hence two minutes rather than one. The
// concurrency ceilings above are what bound the worst case; this deadline is
// what stops a stream that is simply never consumed from holding its slot and
// upstream handle indefinitely. Overridable so a test can exercise the
// watchdog without waiting two minutes.
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

// Per-owner accounting is per PROCESS: with several app instances each has its
// own ceiling, which is the same shape as the in-memory rate-limit fallback
// and keeps the guard database-free on the hottest route in the app.
export class StreamSlotLimiter {
  private total = 0;
  private readonly perOwner = new Map<string, number>();

  constructor(
    private readonly globalMax = MAX_CONCURRENT_FILE_STREAMS,
    private readonly perOwnerMax = MAX_CONCURRENT_FILE_STREAMS_PER_OWNER,
  ) {}

  /** Reserve one stream for `owner`; returns an idempotent release, or null. */
  tryAcquire(owner: string): (() => void) | null {
    const held = this.perOwner.get(owner) ?? 0;
    if (this.total >= this.globalMax || held >= this.perOwnerMax) return null;
    this.total += 1;
    this.perOwner.set(owner, held + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total = Math.max(0, this.total - 1);
      const left = (this.perOwner.get(owner) ?? 1) - 1;
      if (left <= 0) this.perOwner.delete(owner);
      else this.perOwner.set(owner, left);
    };
  }

  /** Active streams (test/observability hook). */
  get active(): number {
    return this.total;
  }

  /** Active streams for one owner (test/observability hook). */
  activeFor(owner: string): number {
    return this.perOwner.get(owner) ?? 0;
  }
}

let limiter: StreamSlotLimiter | null = null;

export function getFileStreamLimiter(): StreamSlotLimiter {
  if (!limiter) limiter = new StreamSlotLimiter();
  return limiter;
}

/** Reserve a slot for one account's file response, or null when saturated. */
export function acquireFileStreamSlot(owner: string): (() => void) | null {
  return getFileStreamLimiter().tryAcquire(owner);
}

export function _resetFileStreamLimiterForTests(): void {
  limiter = null;
}

/**
 * The response body for a storage stream, with a release-on-end/idle slot.
 *
 * `head` is the already-consumed first chunk (replayed ahead of the rest, as
 * the route did inline), `reader` is the storage stream, and `release` gives
 * the concurrency slot back exactly once — on completion, on the consumer's
 * cancel, on a read error, or when the idle deadline fires. The deadline is
 * re-armed on every pull, so an actively-read stream is never cut off however
 * large the object is; only a stream nobody is consuming is retired.
 */
export function createGuardedBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  head: Uint8Array,
  release: () => void,
  idleMs: number = STREAM_IDLE_TIMEOUT_MS,
): ReadableStream<Uint8Array> {
  let headSent = false;
  let released = false;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const finish = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!released) {
      released = true;
      release();
    }
  };

  const arm = () => {
    if (ended) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (ended) return;
      ended = true;
      // Nobody is going to read this object. Cancel the upstream handle (fd or
      // S3 socket), fail the response so the socket is torn down, and return
      // the slot. `controller.error` can throw if the consumer already
      // cancelled, so it is swallowed.
      reader.cancel().catch(() => undefined);
      try {
        controllerRef?.error(new Error("stream-idle-timeout"));
      } catch {
        // already closed/cancelled
      }
      finish();
    }, Math.max(1, idleMs));
    // A stalled response must not keep the process alive on its own.
    (timer as unknown as { unref?: () => void }).unref?.();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      arm();
    },
    async pull(controller) {
      controllerRef = controller;
      arm();
      try {
        if (!headSent) {
          headSent = true;
          if (head.byteLength > 0) {
            controller.enqueue(head);
            return;
          }
        }
        const { done, value } = await reader.read();
        // The idle timer may have fired while this read was in flight; the
        // stream is already errored and the slot released.
        if (ended) return;
        if (done) {
          ended = true;
          controller.close();
          finish();
          return;
        }
        if (value) controller.enqueue(value);
      } catch (e) {
        if (ended) return;
        ended = true;
        controller.error(e);
        finish();
      }
    },
    cancel() {
      if (ended) return;
      ended = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      reader.cancel().catch(() => undefined);
      finish();
    },
  });
}
