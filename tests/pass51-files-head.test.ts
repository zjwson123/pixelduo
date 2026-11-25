import { describe, expect, it, vi } from "vitest";

// Pass 51 — HEAD must not open a storage body.
//
// Next auto-implements HEAD by calling the GET export and then discarding the
// body (send-response ends the response without touching it). Before this fix
// a HEAD on /api/files acquired a stream slot and an S3 GetObject whose reader
// nobody ever pulled; the slot and the socket sat parked until the 120s idle
// deadline. The S3 client's default pool is 50 sockets while the per-owner cap
// is 128, so 51 HEADs from ONE ordinary account exhausted the pool: every media
// GET hung and /api/health's storage probe answered 503 for the whole
// deployment. The admin preview route had the same shape. These tests drive
// the real handlers with only their dependencies stubbed; the property is
// "getStream was not called and no slot is held".

const auth = { uid: "user-1" };
const admin = { uid: "admin-1" };
const calls = { streams: 0, sizes: 0 };
const SIZE = 4096;
const imageModels = { model: "gpt" };

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    requireUserId: async () => auth.uid,
    enforceRateLimit: async () => null,
    enforceUserRateLimit: async () => null,
  };
});

vi.mock("@/lib/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin")>();
  return { ...actual, requireAdmin: async () => admin.uid };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    image: {
      findFirst: async (args: { where: { userId: string; url: string } }) => args.where,
      findUnique: async () => ({ url: "img/admin.png", model: imageModels.model }),
    },
    template: { findFirst: async () => null },
  },
}));

vi.mock("@/lib/storage", () => ({
  getStorage: () => ({
    size: async () => {
      calls.sizes += 1;
      return SIZE;
    },
    getStream: async () => {
      calls.streams += 1;
      return {
        length: 4,
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            const chunk = new Uint8Array(4);
            chunk.set([0x89, 0x50, 0x4e, 0x47]); // PNG magic
            controller.enqueue(chunk);
            controller.close();
          },
        }),
      };
    },
  }),
}));

const { GET } = await import("../app/api/files/[...key]/route");
const { GET: adminGET } = await import("../app/api/admin/images/[id]/route");
const {
  getFileStreamLimiter,
  _resetFileStreamLimiterForTests,
} = await import("../lib/stream-limit");

function filesRequest(key: string, init?: RequestInit): Parameters<typeof GET> {
  return [
    new Request(`http://localhost/api/files/${key}`, init),
    { params: Promise.resolve({ key: key.split("/") }) },
  ];
}

function previewRequest(init?: RequestInit): Parameters<typeof adminGET> {
  return [
    new Request("http://localhost/api/admin/images/img_1", init),
    { params: Promise.resolve({ id: "img_1" }) },
  ];
}

describe("pass 51 — HEAD never opens a storage stream", () => {
  it("/api/files HEAD answers metadata without getStream or a slot", async () => {
    _resetFileStreamLimiterForTests();
    calls.streams = 0;
    calls.sizes = 0;
    const res = await GET(...filesRequest("img/abc.png", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe(String(SIZE));
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(calls.streams).toBe(0);
    expect(calls.sizes).toBe(1);
    expect(getFileStreamLimiter().active).toBe(0);
  });

  it("/api/files HEAD with a Range reports the slice, still without a stream", async () => {
    _resetFileStreamLimiterForTests();
    calls.streams = 0;
    calls.sizes = 0;
    const res = await GET(
      ...filesRequest("img/abc.png", { method: "HEAD", headers: { range: "bytes=0-99" } }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-99/${SIZE}`);
    expect(res.headers.get("content-length")).toBe("100");
    expect(calls.streams).toBe(0);
    // The size needed for the range decision was already fetched.
    expect(calls.sizes).toBe(1);
    expect(getFileStreamLimiter().active).toBe(0);
  });

  it("/api/files GET still streams and releases its slot", async () => {
    _resetFileStreamLimiterForTests();
    calls.streams = 0;
    const res = await GET(...filesRequest("img/abc.png"));
    expect(res.status).toBe(200);
    expect(calls.streams).toBe(1);
    // Consume the body so the guarded stream releases the slot.
    await res.arrayBuffer();
    expect(getFileStreamLimiter().active).toBe(0);
  });

  // Pass 65: the metadata half of the route had no concurrency cap. HEAD and
  // the Range size lookup ran BEFORE the slot was acquired, so 300 concurrent
  // metadata requests from one account queued 300 HeadObjects on the shared S3
  // agent (192 sockets) — the same pool-pinning outage the body cap prevents.
  it("HEAD and Range metadata calls are bounded by the stream cap", async () => {
    _resetFileStreamLimiterForTests();
    calls.streams = 0;
    calls.sizes = 0;
    const limiter = getFileStreamLimiter();
    const releases: Array<() => void> = [];
    // Fill the PROCESS ceiling across several owners; a single filler owner is
    // capped at 64 by the fair-share rules and would leave room for the victim.
    for (let owner = 0; limiter.active < 128 && owner < 32; owner += 1) {
      for (let i = 0; i < 64 && limiter.active < 128; i += 1) {
        const acquired = limiter.tryAcquire(`filler-${owner}`);
        if (!acquired) break;
        releases.push(acquired);
      }
    }
    expect(limiter.active).toBe(128);
    try {
      const head = await GET(...filesRequest("img/abc.png", { method: "HEAD" }));
      expect(head.status).toBe(429);
      const ranged = await GET(
        ...filesRequest("img/abc.png", { headers: { range: "bytes=0-99" } }),
      );
      expect(ranged.status).toBe(429);
      // Neither refusal reached the storage driver.
      expect(calls.sizes).toBe(0);
      expect(calls.streams).toBe(0);
    } finally {
      releases.forEach((release) => release());
    }
    expect(limiter.active).toBe(0);
  });

  // Pass 70: the admin HEAD branch was the one storage metadata call left
  // outside the cap after pass 65 fixed /api/files. A HeadObject still occupies
  // an S3 socket; without a slot, 120 concurrent HEADs (the limiter bounds
  // requests, not concurrency) pin the shared pool alongside two accounts' 128
  // streams and every tenant's media stalls.
  it("admin preview HEAD metadata is bounded by the stream cap", async () => {
    _resetFileStreamLimiterForTests();
    calls.streams = 0;
    calls.sizes = 0;
    const limiter = getFileStreamLimiter();
    const releases: Array<() => void> = [];
    for (let owner = 0; limiter.active < 128 && owner < 32; owner += 1) {
      for (let i = 0; i < 64 && limiter.active < 128; i += 1) {
        const acquired = limiter.tryAcquire(`filler-${owner}`);
        if (!acquired) break;
        releases.push(acquired);
      }
    }
    expect(limiter.active).toBe(128);
    try {
      const res = await adminGET(...previewRequest({ method: "HEAD" }));
      expect(res.status).toBe(429);
      // Refused BEFORE the metadata call: no HeadObject on the shared pool.
      expect(calls.sizes).toBe(0);
      expect(calls.streams).toBe(0);
    } finally {
      releases.forEach((release) => release());
    }
    expect(limiter.active).toBe(0);
  });

  it("admin preview HEAD answers metadata without a stream", async () => {
    _resetFileStreamLimiterForTests();
    calls.streams = 0;
    calls.sizes = 0;
    const res = await adminGET(...previewRequest({ method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(SIZE));
    expect(calls.streams).toBe(0);
    expect(getFileStreamLimiter().active).toBe(0);
  });

  it("admin preview refuses to auto-stream a video row", async () => {
    imageModels.model = "seedance";
    calls.streams = 0;
    try {
      const refused = await adminGET(...previewRequest());
      expect(refused.status).toBe(415);
      expect(calls.streams).toBe(0);

      // The explicit open is still available — one deliberate stream, not 50
      // automatic ones per console page.
      const full = await adminGET(
        new Request("http://localhost/api/admin/images/img_1?full=1"),
        { params: Promise.resolve({ id: "img_1" }) },
      );
      expect(full.status).toBe(200);
      expect(calls.streams).toBe(1);
      await full.arrayBuffer();
    } finally {
      imageModels.model = "gpt";
    }
  });
});
