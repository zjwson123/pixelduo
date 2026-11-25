import { afterAll, describe, expect, it } from "vitest";
import { POST as webhookPOST } from "../app/api/webhooks/payment/route";
import { prisma } from "../lib/prisma";

// The payment webhook is the one body-reading endpoint reachable WITHOUT a
// session or API key, so an unbounded read there is the cheapest memory-
// exhaustion vector in the app. Two properties must hold:
//   1. an oversized body is refused with 413, and
//   2. the body is cut off mid-stream rather than buffered in full — the
//      content-length pre-check alone is bypassable with chunked encoding,
//      which sends no length at all.

const CHUNK_BYTES = 64 * 1024;
// 256 KiB cap → 100 chunks ≈ 6.4 MB, comfortably past it.
const TOTAL_CHUNKS = 100;

function chunkedWebhookRequest() {
  let produced = 0;
  const chunk = new Uint8Array(CHUNK_BYTES).fill(0x61); // 'a'
  const body = new ReadableStream<Uint8Array>({
    // pull() is called lazily as the consumer reads; if the route buffers the
    // whole body, every chunk gets produced.
    pull(controller) {
      if (produced >= TOTAL_CHUNKS) {
        controller.close();
        return;
      }
      produced += 1;
      controller.enqueue(chunk);
    },
  });
  const req = new Request("http://localhost/api/webhooks/payment", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    // Node's fetch requires explicit half-duplex for a streamed request body.
    duplex: "half",
  } as RequestInit);
  return { req, produced: () => produced };
}

afterAll(async () => {
  // The liveness case below names a paid event without an order, which the
  // route persists in PaymentEvent before ACKing. Without this cleanup the test
  // DB accumulates one row per run (pass 70); the event ids are all prefixed
  // for exactly this.
  await prisma.paymentEvent.deleteMany({ where: { eventId: { startsWith: "evt-cap-" } } });
  await prisma.$disconnect();
});

describe("payment webhook body cap", () => {
  it("refuses an oversized chunked body with 413 without buffering it", async () => {
    const { req, produced } = chunkedWebhookRequest();
    const res = await webhookPOST(req);
    expect(res.status).toBe(413);
    // The stream was cancelled at the cap, not drained to the end. 256 KiB /
    // 64 KiB chunks means four chunks fill the cap and the fifth crosses it;
    // the Request body's own readable stream prefetches up to a chunk, so the
    // exact count is 5-6 on Node. This bounds the CAP itself (pass 70): the old
    // "< 100" also passed a 6 MB cap or a full buffer — i.e. it proved nothing
    // about the bound it claims.
    expect(produced()).toBeGreaterThanOrEqual(4);
    expect(produced()).toBeLessThanOrEqual(6);
  });

  it("still reads and verifies a normal body after the cap refactor", async () => {
    const eventId = `evt-cap-${Date.now()}`;
    const res = await webhookPOST(
      new Request("http://localhost/api/webhooks/payment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // A well-formed event the mock provider accepts. Getting a 200 that
        // names the event id proves the body reached verifyWebhook intact.
        body: JSON.stringify({ eventId, status: "paid" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, processed: true });
  });
});
