import { describe, expect, it } from "vitest";
import { ApiError, fail, readBodyCapped } from "../lib/api";

// Expected business errors must map to their proper 4xx status instead of a
// blanket 500, while unexpected errors stay masked as a generic 500.
async function statusOf(error: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = fail(error);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("fail() error classification", () => {
  it("preserves ApiError status codes", async () => {
    const { status, body } = await statusOf(new ApiError(403, "2fa-required"));
    expect(status).toBe(403);
    expect(body.error).toBe("2fa-required");
  });

  it("maps queue pressure to 429", async () => {
    const { status } = await statusOf(new Error("queue-full: max 5 concurrent jobs"));
    expect(status).toBe(429);
  });

  it("maps missing resources to 404 and conflicts to 409", async () => {
    expect((await statusOf(new Error("job-not-found"))).status).toBe(404);
    expect((await statusOf(new Error("email-already-registered"))).status).toBe(409);
  });

  it("maps auth/validation failures to 401/403/400", async () => {
    expect((await statusOf(new Error("invalid-password"))).status).toBe(400);
    expect((await statusOf(new Error("blocked:violence"))).status).toBe(400);
    expect((await statusOf(new Error("admin-required"))).status).toBe(403);
    expect((await statusOf(new Error("verify-email-required"))).status).toBe(403);
  });

  it("masks unexpected errors as a generic 500", async () => {
    const { status, body } = await statusOf(new Error("ECONNRESET at 10.0.0.5:5432"));
    expect(status).toBe(500);
    expect(body.error).toBe("internal-error");
  });

  it("treats a malformed JSON body as a 400", async () => {
    const { status, body } = await statusOf(new SyntaxError("Unexpected token < in JSON"));
    expect(status).toBe(400);
    expect(body.error).toBe("invalid-json");
  });

  it("maps business rules added in the sixth pass", async () => {
    expect((await statusOf(new Error("too-many-keys: revoke one first"))).status).toBe(409);
    expect((await statusOf(new Error("cannot-delete-self"))).status).toBe(400);
    expect((await statusOf(new Error("cannot-demote-self"))).status).toBe(400);
    expect((await statusOf(new Error("2fa-code-required"))).status).toBe(400);
    expect((await statusOf(new Error("user-not-found"))).status).toBe(404);
  });
});

describe("readBodyCap", () => {
  const fakeReq = (contentLength: string | null, text: string): Request =>
    ({
      headers: new Headers({
        "content-type": "application/json",
        ...(contentLength ? { "content-length": contentLength } : {}),
      }),
      text: async () => text,
    }) as unknown as Request;

  // A real Request over a ReadableStream body — exactly what a chunked
  // transfer-encoding request looks like to the route handler (no
  // content-length header at all).
  const streamReq = (chunks: string[]): Request =>
    new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
          controller.close();
        },
      }),
      // @ts-expect-error -- duplex is required when sending a stream body
      duplex: "half",
    });

  it("rejects on the declared content-length before buffering", async () => {
    const r = await readBodyCapped(fakeReq("999999999", "x"), 64 * 1024);
    expect("tooLarge" in r).toBe(true);
  });

  it("rejects a lying/absent content-length after reading", async () => {
    const lying = await readBodyCapped(fakeReq(null, "x".repeat(100)), 64);
    expect("tooLarge" in lying).toBe(true);
  });

  it("returns the raw body for parsing when within the cap", async () => {
    const ok = await readBodyCapped(fakeReq("2", "{}"), 64 * 1024);
    expect("raw" in ok && ok.raw).toBe("{}");
  });

  it("counts bytes, not UTF-16 code units (chunked multibyte body)", async () => {
    // 60 000 CJK chars = 60 000 UTF-16 units (under a 64 KB string-length
    // cap) but 180 000 UTF-8 bytes — the byte-based cap must reject it.
    const r = await readBodyCapped(streamReq(["漢".repeat(60_000)]), 64 * 1024);
    expect("tooLarge" in r).toBe(true);
  });

  it("aborts a chunked stream at the cap instead of buffering it whole", async () => {
    let enqueued = 0;
    let cancelled = false;
    const chunk = "x".repeat(1024);
    const req = new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          enqueued += 1;
          controller.enqueue(new TextEncoder().encode(chunk));
        },
        cancel() {
          cancelled = true;
        },
      }),
      // @ts-expect-error -- duplex is required when sending a stream body
      duplex: "half",
    });
    const r = await readBodyCapped(req, 4 * 1024);
    expect("tooLarge" in r).toBe(true);
    // The reader must have stopped after the chunks that crossed the cap —
    // not drained an endless body into memory first.
    expect(enqueued).toBeLessThan(16);
    expect(cancelled).toBe(true);
  });

  it("reassembles a multi-chunk body within the cap", async () => {
    const r = await readBodyCapped(streamReq(['{"a":', "1}"]), 64 * 1024);
    expect("raw" in r && r.raw).toBe('{"a":1}');
  });
});

describe("fail() must not classify on substrings", () => {
  // The classifier tested `msg.includes("already")`, `includes("not-found")`
  // and `includes("insufficient")`, so an UNEXPECTED internal error whose text
  // merely contained one of those words was echoed to the API client verbatim
  // as a 4xx and skipped captureError() — the caller saw raw internals and the
  // incident never reached the logs or Sentry. These two strings are Prisma's
  // own transaction-manager errors (see @prisma/client/runtime/client.js).
  const incidents = [
    "Transaction already closed: A query cannot be executed on a transaction that was rolled back.",
    "Transaction already closed: A query cannot be executed on a transaction that was committed.",
    "there is insufficient privilege to access the table",
    "unexpected not-found in the internal registry",
  ];

  for (const msg of incidents) {
    it(`masks ${JSON.stringify(msg.slice(0, 40))}… as a 500 and does not echo it`, async () => {
      const { status, body } = await statusOf(new Error(msg));
      expect(status).toBe(500);
      expect(body.error).toBe("internal-error");
    });
  }

  it("still classifies the real business messages", async () => {
    expect((await statusOf(new Error("email-already-registered"))).status).toBe(409);
    expect((await statusOf(new Error("user-not-found"))).status).toBe(404);
    expect((await statusOf(new Error("insufficient-credits"))).status).toBe(400);
  });
});
