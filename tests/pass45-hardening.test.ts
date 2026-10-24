import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../lib/prisma";
import { refuseCrossSiteRequest } from "../lib/api";

// The five body-less mutating routes are called directly here. lib/api imports
// next-auth, so the session is mocked the way every other route test in this
// suite does it (tests/pass42-hardening.test.ts): vi.hoisted so the factory can
// run while the static imports above are still being evaluated.
const { getServerSession } = vi.hoisted(() => ({ getServerSession: vi.fn() }));
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: (...args: unknown[]) => getServerSession(...args) };
});

const { POST: checkin } = await import("../app/api/checkin/route");
const { POST: exportData } = await import("../app/api/account/export/route");
const { POST: requestVerification } = await import("../app/api/auth/request-verification/route");
const { POST: revokeSessions } = await import("../app/api/auth/revoke-sessions/route");
const { POST: revokeKey } = await import("../app/api/account/keys/[id]/revoke/route");

// Pass 45: the JSON media-type rule readBodyCapped enforces on every
// body-reading route is what stops a cross-site form from driving it. The five
// state-changing POSTs that take no body never reached that rule, so a
// same-site page (a sibling subdomain, or another port on the same host — any
// "same-site" origin that a Lax cookie still rides) could log the owner out of
// every device, revoke a key, spend the daily check-in, rotate a verification
// link or make the export query run. refuseCrossSiteRequest reads the browser's
// own Sec-Fetch-Site label; a request with no Sec-Fetch-* header is a
// non-browser client and stays accepted.

const tag = `pass45-${Date.now()}`;
let seq = 0;

async function makeUser(): Promise<{ id: string; email: string }> {
  const email = `${tag}-${seq++}@test.dev`;
  const user = await prisma.user.create({
    data: { email, passwordHash: "x", name: "Pass 45", emailVerified: new Date() },
  });
  return { id: user.id, email };
}

function req(init?: { site?: string }): Request {
  const headers = new Headers();
  if (init?.site) headers.set("sec-fetch-site", init.site);
  return new Request("http://localhost/api/x", { method: "POST", headers });
}

afterAll(async () => {
  const users = await prisma.user.findMany({ where: { email: { startsWith: tag } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await prisma.apiKey.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe("pass 45 — the browser-CSRF guard on body-less mutating routes", () => {
  it("accepts same-origin, browser-internal and non-browser requests; refuses same-site and cross-site", () => {
    expect(() => refuseCrossSiteRequest(req())).not.toThrow();
    expect(() => refuseCrossSiteRequest(req({ site: "same-origin" }))).not.toThrow();
    expect(() => refuseCrossSiteRequest(req({ site: "none" }))).not.toThrow();
    for (const site of ["same-site", "cross-site", "SOMETHING-ELSE"]) {
      expect(() => refuseCrossSiteRequest(req({ site }))).toThrow(/cross-site-request/);
    }
  });

  it("refuses a same-site check-in before it writes anything", async () => {
    const user = await makeUser();
    getServerSession.mockResolvedValue({ user: { id: user.id, sv: 0, totpPending: false } });
    const res = await checkin(req({ site: "same-site" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: expect.stringContaining("cross-site-request") });
    expect(await prisma.checkin.count({ where: { userId: user.id } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(0);
  });

  it("still performs a same-origin check-in", async () => {
    const user = await makeUser();
    getServerSession.mockResolvedValue({ user: { id: user.id, sv: 0, totpPending: false } });
    const res = await checkin(req({ site: "same-origin" }));
    expect(res.status).toBe(200);
    expect(await prisma.checkin.count({ where: { userId: user.id } })).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(2);
  });

  it("refuses a same-site export before the caller is even resolved", async () => {
    const res = await exportData(req({ site: "same-site" }));
    expect(res.status).toBe(403);
  });

  it("refuses a same-site verification resend and mints no token", async () => {
    const user = await makeUser();
    getServerSession.mockResolvedValue({ user: { id: user.id, sv: 0, totpPending: false } });
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: null } });
    const res = await requestVerification(req({ site: "same-site" }));
    expect(res.status).toBe(403);
    expect(await prisma.verificationToken.count({ where: { userId: user.id } })).toBe(0);
  });

  it("refuses a same-site revoke-sessions and leaves the session version alone", async () => {
    const user = await makeUser();
    getServerSession.mockResolvedValue({ user: { id: user.id, sv: 0, totpPending: false } });
    const res = await revokeSessions(req({ site: "same-site" }));
    expect(res.status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion).toBe(0);
  });

  it("refuses a same-site key revocation and leaves the key active", async () => {
    const user = await makeUser();
    getServerSession.mockResolvedValue({ user: { id: user.id, sv: 0, totpPending: false } });
    const key = await prisma.apiKey.create({
      data: { userId: user.id, name: "pass45", keyHash: `${tag}-${seq++}`, prefix: "pd_live_PASS", sessionVersion: 0 },
    });
    const res = await revokeKey(req({ site: "same-site" }), { params: Promise.resolve({ id: key.id }) });
    expect(res.status).toBe(403);
    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } });
    expect(row.revokedAt).toBeNull();
  });
});
