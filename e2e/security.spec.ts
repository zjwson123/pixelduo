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

// Pass 64: next-auth's assertConfig validates `callbackUrl` (query and cookie)
// before CSRF, the session and our redirect callback, and answers a 500
// "There is a problem with the server configuration" for anything it cannot
// parse — anonymously, from a GET an <img> tag can send. This is the real
// next-auth path (unit tests mock the handler): the wrapper must refuse first,
// and a poisoned cookie must be cleared rather than failing every auth request
// for the life of the browser session.
test.describe("next-auth callbackUrl", () => {
  test("a malformed callbackUrl is a client error, not next-auth's 500", async ({ request }) => {
    for (const value of ["foo", "javascript:alert(1)", "https://"]) {
      const res = await request.get(`/api/auth/session?callbackUrl=${encodeURIComponent(value)}`, {
        failOnStatusCode: false,
      });
      expect(res.status(), value).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok, value).toBe(false);
      expect(body.error, value).toContain("invalid-input");
    }
    // Duplicates: next-auth reads the last value, so the first cannot be the
    // one that is checked.
    const dup = await request.get("/api/auth/session?callbackUrl=%2Fstudio&callbackUrl=foo", {
      failOnStatusCode: false,
    });
    expect(dup.status()).toBe(400);
  });

  test("a poisoned callback-url cookie is cleared instead of bricking auth", async ({ request }) => {
    // All three spellings the app can encounter; the configured one is the only
    // one the wrapper checks, and it is what must be cleared.
    const res = await request.get("/api/auth/session", {
      headers: {
        cookie:
          "__Host-next-auth.callback-url=foo; __Secure-next-auth.callback-url=foo; next-auth.callback-url=foo",
      },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
    expect(res.headers()["set-cookie"] ?? "").toContain("callback-url=");
  });
});

// Pass 65: Next's internal `/:path+/` 308 is resolved after the headers() rules
// and discards them, so a trailing-slash token link answered a
// heuristically-cacheable redirect whose Location carried the live single-use
// token. `skipTrailingSlashRedirect` makes the page answer at the slash URL,
// where the existing no-store rule (its regex already accepts the slash)
// applies. This must be the built server: the redirect is routing, not a page.
test.describe("token pages at a trailing slash", () => {
  test("answer directly with no-store instead of redirecting the token", async ({ request }) => {
    for (const path of ["/reset-password/?token=e2e-token", "/verify-email/?token=e2e-token"]) {
      const res = await request.get(path, { failOnStatusCode: false, maxRedirects: 0 });
      expect(res.status(), path).toBe(200);
      expect(res.headers()["cache-control"], path).toContain("no-store");
      expect(res.headers()["location"], path).toBeUndefined();
    }
  });
});
