import { test, expect } from "@playwright/test";

// Pass 50: Next's router decodes dynamic route params with
// decodeURIComponent before any handler runs, and throws for an escape that is
// not valid UTF-8. That throw escaped every guard (refuseNul, fail, the
// route-level limiters) and answered Next's bare 500 "Internal Server Error"
// anonymously — one incident per request on a deployment with SENTRY_DSN, and
// a bare `%` reset the socket. This is the only check that exercises the real
// router rather than the predicate, so it must run against the built server.
test.describe("malformed request paths", () => {
  test("an undecodable segment is a 400 JSON error, not a bare 500", async ({ request }) => {
    for (const path of [
      "/api/jobs/%FF", // invalid UTF-8 byte
      "/api/files/img/%FF.png",
      "/api/admin/users/%ED%A0%80", // CESU-8 lone surrogate
      "/api/auth/2fa-status/%FF", // the [...nextauth] catch-all
    ]) {
      const res = await request.get(path, { failOnStatusCode: false });
      expect(res.status(), path).toBe(400);
      expect(res.headers()["content-type"], path).toContain("application/json");
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok, path).toBe(false);
      expect(body.error, path).toContain("invalid-path");
    }
  });

  test("a valid escape still reaches the route (and its auth guard)", async ({ request }) => {
    // %25 is a literal "%": it decodes once and must not be refused here. The
    // route itself answers 401 without a session, which proves it ran.
    const res = await request.get("/api/jobs/%25", { failOnStatusCode: false });
    expect(res.status()).toBe(401);
  });
});

// Pass 63: a same-site sibling origin could send a simple text/plain POST that
// carried the Lax session cookie, spent the victim's account-keyed bucket and
// only then met readBodyCapped's 415. The refusal must happen in the proxy,
// before any bucket, and the browser's Sec-Fetch-Site label is what identifies
// it. This exercises the wired middleware, not just the predicate.
test.describe("foreign browser mutations", () => {
  test("a same-site POST is refused before auth and the account limiter", async ({ request }) => {
    const res = await request.post("/api/generate", {
      headers: { "content-type": "application/json", "sec-fetch-site": "same-site" },
      data: { prompt: "a calm lake", model: "gpt", quality: "medium" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("cross-site-request");
  });

  test("an ordinary same-origin request is not blocked by that guard", async ({ request }) => {
    // No session, so the route's own guard answers 401 — which proves the
    // request got past the proxy.
    const res = await request.post("/api/generate", {
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      data: { prompt: "a calm lake", model: "gpt", quality: "medium" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(401);
  });
});
