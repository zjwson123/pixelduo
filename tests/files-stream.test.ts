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

vi.mock("@/lib/storage", () => ({
  getStorage: () => ({
    getStream: async () => ({
      length: CHUNKS * CHUNK_BYTES,
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
    }),
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
