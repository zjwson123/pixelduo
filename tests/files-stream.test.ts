import { describe, expect, it, vi } from "vitest";

// The route is driven for real; only its dependencies are stubbed. This is the
// code path that serves every generated image and video, and the property under
// test is a MEMORY bound, so the source stream counts how many chunks the route
// has pulled from it.
const auth = { uid: "user-1" };

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    requireUserId: async () => auth.uid,
    enforceRateLimit: async () => null,
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    image: { findFirst: async (args: { where: { userId: string; url: string } }) => args.where },
    template: { findFirst: async () => null },
  },
}));

const CHUNKS = 50;
const CHUNK_BYTES = 64 * 1024;
const source = { pulls: 0 };

const rangeCalls: Array<{ start: number; end: number } | undefined> = [];
const TOTAL = 50 * 64 * 1024;
// A driver that IGNORES the Range header (some S3-compatible gateways/proxies
// do) answers the whole object with the full ContentLength. The route must
// refuse that instead of emitting a 206 whose declared length is the range's
// (pass 70).
const driver = { honoursRange: true };

vi.mock("@/lib/storage", () => ({
  getStorage: () => ({
    size: async () => TOTAL,
    getStream: async (_key: string, range?: { start: number; end: number }) => {
      rangeCalls.push(range);
      return {
        length:
          range && driver.honoursRange ? range.end - range.start + 1 : CHUNKS * CHUNK_BYTES,
        total: TOTAL,
      stream: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (source.pulls >= CHUNKS) {
            controller.close();
            return;
          }
          const first = source.pulls === 0;
          const chunk = new Uint8Array(CHUNK_BYTES);
          if (first) {
            // PNG magic so the route's sniffing path is exercised.
            chunk.set([0x89, 0x50, 0x4e, 0x47], 0);
          }
          source.pulls += 1;
          controller.enqueue(chunk);
        },
      }),
      };
    },
  }),
}));

const { GET } = await import("../app/api/files/[...key]/route");

function request(key: string): [Request, { params: Promise<{ key: string[] }> }] {
  return [
    new Request(`http://localhost/api/files/${key}`),
    { params: Promise.resolve({ key: key.split("/") }) },
  ];
}

// The old implementation read the whole object inside the stream's start()
// callback, and controller.enqueue never blocks — so the entire object sat in
// the response's queue within milliseconds of the response being constructed,
// before any byte reached the socket. Heap stayed at N × object-size for the
// life of the connection (Node's requestTimeout allows 300s), which is the
// outage the earlier "streaming" rewrite was supposed to prevent.
describe("/api/files streams with consumer backpressure", () => {
  it("does not drain the object before the consumer reads it", async () => {
    source.pulls = 0;
    const [req, ctx] = request("img/abc.png");
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    // Give an eager reader every chance to run: the old start() loop drained
    // the source in a chain of microtasks, so asserting immediately could pass
    // by luck of scheduling. After a macrotask it has either pulled the whole
    // object or it is waiting on the consumer — the property under test.
    await new Promise((r) => setTimeout(r, 25));
    // One sniffed chunk plus at most the source's own single-chunk prefetch.
    expect(source.pulls).toBeLessThanOrEqual(3);

    // The bytes still arrive intact (magic byte first, full length).
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBe(CHUNKS * CHUNK_BYTES);
    expect([...body.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(source.pulls).toBe(CHUNKS);
  });

  it("stops reading the object when the consumer cancels", async () => {
    source.pulls = 0;
    const [req, ctx] = request("img/abc.png");
    const res = await GET(req, ctx);
    const reader = res.body!.getReader();
    await reader.read();
    const pulledBefore = source.pulls;
    await reader.cancel();
    // Nothing further is requested once the client goes away.
    expect(source.pulls).toBe(pulledBefore);
  });
});

// Range requests (RFC 9110 §14.2). Every `<video>` element sends one, and a 200
// with no Accept-Ranges is what makes a clip non-seekable — Safari refuses to
// play such a source at all — and an interrupted download restarts from zero.
// /api/jobs and /api/gallery hand the workbench /api/files/<key> URLs, so this
// is the path every generated video travels.
describe("/api/files honours Range requests", () => {
  it("answers a byte range with 206, Content-Range and the slice's length", async () => {
    rangeCalls.length = 0;
    const [req, ctx] = request("img/clip.mp4");
    req.headers.set("range", "bytes=100-199");
    const res = await GET(req, ctx);
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 100-199/${TOTAL}`);
    expect(res.headers.get("Content-Length")).toBe("100");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    // The slice really was requested from the driver, not downloaded whole.
    expect(rangeCalls[0]).toEqual({ start: 100, end: 199 });
  });

  it("resolves an open-ended range against the object size", async () => {
    rangeCalls.length = 0;
    const [req, ctx] = request("img/clip.mp4");
    req.headers.set("range", `bytes=${TOTAL - 50}-`);
    const res = await GET(req, ctx);
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes ${TOTAL - 50}-${TOTAL - 1}/${TOTAL}`);
    expect(res.headers.get("Content-Length")).toBe("50");
  });

  it("answers a suffix range with the last N bytes", async () => {
    const [req, ctx] = request("img/clip.mp4");
    req.headers.set("range", "bytes=-64");
    const res = await GET(req, ctx);
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes ${TOTAL - 64}-${TOTAL - 1}/${TOTAL}`);
  });

  it("answers a range past the end with 416, not a 200 restart", async () => {
    // A browser sends this after a stale seek. 200 restarts the download; 404
    // (which is what a driver error would produce) hides a perfectly good file.
    const [req, ctx] = request("img/clip.mp4");
    req.headers.set("range", `bytes=${TOTAL + 10}-`);
    const res = await GET(req, ctx);
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe(`bytes */${TOTAL}`);
  });

  it("ignores a range it cannot serve and answers the whole object", async () => {
    rangeCalls.length = 0;
    const [req, ctx] = request("img/clip.mp4");
    req.headers.set("range", "bytes=0-99,200-299"); // multi-range: not supported
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Range")).toBeNull();
    expect(rangeCalls[0]).toBeUndefined();
    // Accept-Ranges is still advertised, so the client knows it may ask again.
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
  });

  it("still sniffs the content type from byte 0 when the range starts there", async () => {
    source.pulls = 0; // the mock's stream restarts only when the source is fresh
    const [req, ctx] = request("img/abc.png");
    req.headers.set("range", "bytes=0-1023");
    const res = await GET(req, ctx);
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  it("refuses a 206 whose backend returned the whole object instead of the range", async () => {
    // A gateway that ignores Range answers 200 with the full object and a full
    // ContentLength. Serving that body under the range's Content-Length
    // desynchronizes the connection (keep-alive framing / HTTP/2 stream error),
    // so the route fails closed before reading a byte.
    driver.honoursRange = false;
    source.pulls = 0;
    try {
      const [req, ctx] = request("img/clip.mp4");
      req.headers.set("range", "bytes=100-199");
      const res = await GET(req, ctx);
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ ok: false, error: expect.stringContaining("storage-range-mismatch") });
      // Only the readable stream's own single-chunk prefetch: the route never
      // acquired a reader, so nothing was consumed from the body.
      expect(source.pulls).toBeLessThanOrEqual(1);
    } finally {
      driver.honoursRange = true;
    }
  });

  it("falls back to the key's extension for a mid-file range", async () => {
    // Magic bytes only live at the start of the OBJECT, so a mid-file slice has
    // none to sniff — the old code would have served application/octet-stream.
    const [req, ctx] = request("img/clip.mp4");
    req.headers.set("range", "bytes=1024-2047");
    const res = await GET(req, ctx);
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
  });
});
