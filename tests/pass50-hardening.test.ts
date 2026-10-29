import { afterAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { malformedPercentPath, proxy, rawPathOf } from "../proxy";
import { prisma } from "../lib/prisma";
import { fulfillOrder, revokeOrderCreditsTx } from "../lib/ledger";

// Pass 50: Next's router decodes every dynamic route segment with
// decodeURIComponent, and that call throws before any handler runs for an
// escape that is not valid UTF-8. Nothing in the app could see or map it: the
// caller got Next's bare 500 "Internal Server Error" (no JSON, no fail()
// classification, no route-level limiter) — reachable without a credential, so
// with SENTRY_DSN configured it was one handled:false incident per request,
// and a bare `%` reset the socket instead of answering. The middleware refuses
// it now, after its buckets are charged.
//
// These cases pin the predicate (which must accept every legitimate encoding,
// including percent-encoded UTF-8 and an escaped literal %) and the proxy's
// behaviour for both the API and the catch-all auth path.

function reqFor(path: string, ip: string) {
  return new NextRequest(new URL(`http://localhost:3100${path}`), {
    headers: { "x-forwarded-for": `10.0.0.7, ${ip}`, "sec-fetch-site": "same-origin" },
  });
}

function withLimit<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.MIDDLEWARE_API_LIMIT;
  process.env.MIDDLEWARE_API_LIMIT = "1000";
  return fn().finally(() => {
    if (saved === undefined) delete process.env.MIDDLEWARE_API_LIMIT;
    else process.env.MIDDLEWARE_API_LIMIT = saved;
  });
}

describe("pass 50 — malformed percent-encoding in a request path", () => {
  it("refuses every escape the router cannot decode", () => {
    for (const url of [
      "http://h/api/jobs/%FF",
      "http://h/api/jobs/%ff",
      "http://h/api/jobs/%C0%AF", // overlong encoding of "/"
      "http://h/api/jobs/%ED%A0%80", // CESU-8 lone surrogate
      "http://h/api/admin/users/%E0%80",
      "http://h/api/jobs/%", // bare marker, not an escape
      "http://h/api/jobs/%2",
      "http://h/api/jobs/%GG",
      "http://h/api/jobs/a%FFb",
    ]) {
      expect(malformedPercentPath(url), url).toBe(true);
    }
  });

  it("accepts valid paths, percent-encoded UTF-8 and an escaped literal percent", () => {
    for (const url of [
      "http://h/api/jobs/abc",
      "http://h/api/files/img/0b0d1c9a-1.png",
      "http://h/api/files/img/%E4%B8%AD.png", // valid UTF-8 (中)
      "http://h/api/jobs/%25", // a literal "%": decodes once, no throw
      "http://h/api/health",
    ]) {
      expect(malformedPercentPath(url), url).toBe(false);
    }
  });

  it("only judges the path, never the query string", () => {
    // WHATWG query parsing replaces an invalid byte instead of throwing, which
    // is what the routes' own queryText guards were written against; this
    // check must not turn a bad ?q= into a path refusal.
    expect(malformedPercentPath("http://h/api/templates?q=%FF")).toBe(false);
    expect(malformedPercentPath("http://h/api/templates?q=ok#%FF")).toBe(false);
    expect(rawPathOf("http://h/api/templates?q=%FF#frag")).toBe("/api/templates");
    expect(rawPathOf("/api/jobs/%FF?x=1")).toBe("/api/jobs/%FF");
  });

  it("answers 400 with a JSON error and no-store, not Next's bare 500", () =>
    withLimit(async () => {
      for (const path of [
        "/api/jobs/%FF",
        "/api/files/img/%FF.png",
        "/api/admin/users/%ED%A0%80",
        // The /api/auth/[...nextauth] catch-all is the fourth shape: it has no
        // [id] segment of its own, but an extra path segment reaches the same
        // decoder.
        "/api/auth/2fa-status/%FF",
      ]) {
        const res = await proxy(reqFor(path, "198.51.100.50"));
        expect(res.status, path).toBe(400);
        expect(res.headers.get("cache-control"), path).toBe("private, no-store");
        const body = (await res.json()) as { ok: boolean; error: string };
        expect(body.ok).toBe(false);
        expect(body.error).toContain("invalid-path");
      }
    }));

  it("still routes ordinary and validly-encoded paths", () =>
    withLimit(async () => {
      for (const path of ["/api/jobs/abc", "/api/files/img/%E4%B8%AD.png", "/api/jobs/%25"]) {
        const res = await proxy(reqFor(path, "198.51.100.51"));
        // NextResponse.next() answers 200 with x-middleware-next.
        expect(res.status, path).toBe(200);
        expect(res.headers.get("x-middleware-next"), path).toBe("1");
      }
    }));

  it("charges the caller's bucket before refusing (a refusal is still a request)", async () => {
    const saved = process.env.MIDDLEWARE_API_LIMIT;
    process.env.MIDDLEWARE_API_LIMIT = "1";
    try {
      const first = await proxy(reqFor("/api/jobs/%FF", "198.51.100.52"));
      expect(first.status).toBe(400);
      const second = await proxy(reqFor("/api/jobs/%FF", "198.51.100.52"));
      // The bucket was already spent by the first malformed request, so the
      // second is the ordinary 429 — not a second free 400 for an anonymous
      // caller looping the decode path.
      expect(second.status).toBe(429);
    } finally {
      if (saved === undefined) delete process.env.MIDDLEWARE_API_LIMIT;
      else process.env.MIDDLEWARE_API_LIMIT = saved;
    }
  });
});

// The refund's credit revocation assumed User.credits always covers the
// remaining held by the refunded order's grants — true on every account this
// code has ever written, false on the legacy/restored rows the invariant
// repairs exist for. There, addCreditsTx's negative-balance refusal rolled the
// WHOLE webhook transaction back: the order never left "paid" (so every
// provider retry reproduced it), the credits stayed, and — the expensive half
// — revokePlanEntitlementTx never ran either, so a refunded subscription kept
// its paid tier. The repair script fixes such an account, but the money path
// must not depend on an operator running it after the customer's money is
// already back.
describe("pass 50 — a refund completes on a legacy-drifted balance", () => {
  const tag = `pass50-drift-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  });

  it("revokes what the balance can back instead of throwing insufficient-credits", async () => {
    const user = await prisma.user.create({ data: { email: `${tag}@test.dev`, passwordHash: "x" } });
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        provider: "mock",
        amountUsd: 9.99,
        credits: 100,
        idempotencyKey: `${tag}-order`,
      },
    });
    await fulfillOrder(user.id, order.id, "pack", 100);
    // The legacy drift: the grant rows still hold 100, the balance column says
    // 40. (Both the CHECK ... NOT VALID migration and
    // scripts/repair-credit-invariant.ts exist precisely because such rows do.)
    await prisma.user.update({ where: { id: user.id }, data: { credits: 40 } });
    await prisma.order.update({ where: { id: order.id }, data: { status: "refunded" } });

    const revoked = await prisma.$transaction((tx) =>
      revokeOrderCreditsTx(tx, { id: order.id, userId: user.id }),
    );
    expect(revoked).toBe(40);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { credits: true } });
    expect(after.credits).toBe(0);
    const grant = await prisma.creditGrant.findFirstOrThrow({
      where: { userId: user.id, refType: "order", refId: order.id },
      select: { remaining: true },
    });
    expect(grant.remaining).toBe(0);
  });
});
