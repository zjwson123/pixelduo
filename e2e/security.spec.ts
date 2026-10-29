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
