import { afterAll, describe, expect, it, vi } from "vitest";

// Pass-68 pins for the payment webhook's input validation. The route is the one
// JSON body in the app that cannot go through parseJsonBody's VALUE (the raw
// bytes are what the provider's HMAC covers), and on a mock deployment its
// verifier accepts UNSIGNED bodies — so it was the anonymous way to put an
// escaped NUL, a lone surrogate or a non-string id in front of Prisma. Each of
// those was an UNEXPECTED error: fail() masked it as a 500 and captureError
// filed an incident, the "anonymous incident faucet" class passes 25/30/38
// closed everywhere else. The body now passes the same deep character check as
// every other route, and the mock verifier type-checks the ids it forwards.

// captureError is the signal that must NOT fire for garbage input.
const captured: Array<{ message: string }> = [];
vi.mock("../lib/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/observability")>();
  return {
    ...actual,
    captureError: (e: unknown) => {
      captured.push({ message: e instanceof Error ? e.message : String(e) });
    },
  };
});

// The route imports lib/api, which imports next-auth. No session is read on
// this path; the module just has to resolve without booting Next.
vi.mock("next-auth", () => ({ getServerSession: async () => null }));

// In-process limiter, so this file's webhook buckets never reach Redis.
delete process.env.REDIS_URL;
process.env.PAYMENT_PROVIDER = "mock";

const { prisma } = await import("../lib/prisma");
const { POST: webhookPOST } = await import("../app/api/webhooks/payment/route");

const stamp = Date.now();

function post(raw: string) {
  return webhookPOST(
    new Request("http://localhost/api/webhooks/payment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    }),
  );
}

afterAll(async () => {
  await prisma.paymentEvent.deleteMany({ where: { eventId: { startsWith: `p68-${stamp}` } } });
  await prisma.$disconnect();
});

describe("pass 68 — the webhook refuses bodies it cannot represent", () => {
  it("an ESCAPED NUL is a 400, not SQLSTATE 22021 masked as a 500", async () => {
    captured.length = 0;
    // `readBodyCapped` sees seven ASCII characters; JSON.parse makes the real
    // U+0000, which PostgreSQL's text type rejects at the first Prisma lookup.
    const res = await post(`{"eventId":"p68-${stamp}-nul\\u0000x"}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/NUL/i);
    expect(captured).toEqual([]);
  });

  it("a lone surrogate is refused as malformed text", async () => {
    captured.length = 0;
    const res = await post(`{"eventId":"p68-${stamp}-sur\\ud800"}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/malformed/i);
    expect(captured).toEqual([]);
  });

  it("a non-string event id or order id is a client error, not a Prisma type error", async () => {
    captured.length = 0;
    for (const raw of [
      `{"eventId":{"$ne":null}}`,
      `{"eventId":["p68-${stamp}"]}`,
      `{"eventId":"p68-${stamp}-type","orderId":123}`,
      `{"eventId":"p68-${stamp}-type","orderId":[]}`,
      `{"eventId":"p68-${stamp}-type","orderId":"${"x".repeat(65)}"}`,
    ]) {
      const res = await post(raw);
      expect(res.status, raw.slice(0, 60)).toBe(400);
      expect(captured, raw.slice(0, 60)).toEqual([]);
    }
  });

  it("keeps the pass-23 signal: a well-formed paid event with no order is acked AND reported", async () => {
    // Proof the validation did not over-block: this is real operator signal on
    // a provider deployment, and it must survive (the mock path can only report
    // it because the event is unsigned — that is the mock provider's contract).
    captured.length = 0;
    const res = await post(
      JSON.stringify({
        eventId: `p68-${stamp}-orphan`,
        status: "paid",
        orderId: "order-that-does-not-exist",
      }),
    );
    expect(res.status).toBe(200);
    expect(captured.map((c) => c.message).join("\n")).toMatch(/resolved no order/);
  });
});
