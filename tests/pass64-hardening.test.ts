import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Pass 64.
//
// next-auth's assertConfig validates the `callbackUrl` query parameter and the
// callback-url cookie on EVERY /api/auth/* request, before the CSRF token and
// before our redirect callback, and answers
//   500 {"message":"There is a problem with the server configuration…"}
// for anything it cannot parse as a relative path or http(s) URL. Pass 41 added
// a same-origin-only redirect callback and tested THAT, so the endpoint kept
// answering 500 anonymously (probed: `?callbackUrl=foo`, `javascript:…`,
// `https://`). The wrapper now answers 400 first, and clears a poisoned cookie
// (which otherwise 500s every auth request until the browser session ends).
//
// The handler is mocked: what this file pins is the wrapper's decision to
// refuse before delegation. The real next-auth path is pinned in
// e2e/security.spec.ts against the built server.

const { delegated } = vi.hoisted(() => ({ delegated: vi.fn() }));

vi.mock("next-auth", () => ({
  __esModule: true,
  default: () => delegated,
  getServerSession: async () => null,
}));

const { GET } = await import("../app/api/auth/[...nextauth]/route");
const { authCallbackCookieName, authCallbackUrlAcceptable } = await import("../lib/auth-cookies");

delegated.mockImplementation(
  async () =>
    new Response(JSON.stringify({ delegated: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
);

const ok = () => delegated.mock.calls.length > 0;

// One bucket per test process: the wrapper's per-IP limiter is shared with every
// other file through Redis, and a fixed address would make this suite's budget
// depend on what ran before it.
const ip = `198.51.100.${(Math.floor(Date.now() / 1000) % 200) + 1}`;

function call(path: string, cookie?: string) {
  return GET(
    new NextRequest(`http://localhost:3000${path}`, {
      headers: { "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) },
    }),
    { params: Promise.resolve({ nextauth: ["session"] }) } as never,
  );
}

beforeEach(() => {
  delegated.mockClear();
});

describe("pass 64 — a malformed next-auth callbackUrl is a 400, not a 500", () => {
  it("mirrors next-auth's acceptance rule exactly", () => {
    const base = "http://localhost:3000";
    // Accepted by next-auth (assertConfig's isValidHttpUrl).
    expect(authCallbackUrlAcceptable("/studio", base)).toBe(true);
    expect(authCallbackUrlAcceptable("https://example.com/after", base)).toBe(true);
    // Protocol-relative counts as relative to next-auth; our redirect callback
    // is what refuses the foreign origin later.
    expect(authCallbackUrlAcceptable("//evil.example/x", base)).toBe(true);
    // Refused by next-auth with a 500.
    expect(authCallbackUrlAcceptable("foo", base)).toBe(false);
    expect(authCallbackUrlAcceptable("javascript:alert(1)", base)).toBe(false);
    expect(authCallbackUrlAcceptable("https://", base)).toBe(false);
    expect(authCallbackUrlAcceptable("https://a b", base)).toBe(false);
  });

  it("refuses every shape next-auth would 500 on", async () => {
    for (const value of ["foo", "javascript:alert(1)", "https://"]) {
      const res = await call(`/api/auth/session?callbackUrl=${encodeURIComponent(value)}`);
      expect(res.status, value).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok, value).toBe(false);
      expect(body.error, value).toContain("invalid-input");
    }
    expect(ok()).toBe(false);
  });

  it("checks every duplicate, because next-auth reads the last one", async () => {
    // searchParams.get() returns the FIRST; next-auth's Object.fromEntries
    // keeps the LAST. Checking only the first would leave this 500 reachable.
    const res = await call("/api/auth/session?callbackUrl=%2Fstudio&callbackUrl=foo");
    expect(res.status).toBe(400);
    expect(ok()).toBe(false);
  });

  it("still delegates the values next-auth accepts", async () => {
    for (const value of ["/studio", "https://example.com/after"]) {
      const res = await call(`/api/auth/session?callbackUrl=${encodeURIComponent(value)}`);
      expect(res.status, value).toBe(200);
    }
    // An empty value is falsy in next-auth's guard: ignored, not refused.
    expect((await call("/api/auth/session?callbackUrl=")).status).toBe(200);
    expect(ok()).toBe(true);
  });

  it("clears a poisoned callback-url cookie instead of locking the browser out", async () => {
    const name = authCallbackCookieName();
    const res = await call("/api/auth/session", `${name}=foo`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("cleared");
    const setCookie = res.headers.getSetCookie().join("\n");
    expect(setCookie).toContain(`${name}=;`);
    expect(setCookie.toLowerCase()).toContain("max-age=0");
    expect(ok()).toBe(false);

    // A valid cookie is left alone and delegated.
    const fine = await call("/api/auth/session", `${name}=%2Fstudio`);
    expect(fine.status).toBe(200);
    expect(fine.headers.getSetCookie()).toHaveLength(0);
  });
});
