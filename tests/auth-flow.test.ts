import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { createToken, consumeToken, purgeExpiredTokens } from "../lib/tokens";
import { POST as registerPOST } from "../app/api/register/route";
import { POST as verifyEmailPOST } from "../app/api/auth/verify-email/route";
import { POST as forgotPOST } from "../app/api/auth/forgot-password/route";
import { POST as resetPOST } from "../app/api/auth/reset-password/route";

let userId: string;
let email: string;
let ipSeq = 0;
const origVerifyAuto = process.env.EMAIL_VERIFY_AUTO;
// A per-RUN second octet plus a per-CALL third octet. Limiter buckets are keyed
// by client IP for the whole window (forgot-password allows 5 per 15 minutes),
// so a fixed address sequence reused every run made the SECOND run of this file
// inside that window answer 429 — a red suite with no code change behind it.
// ci-local clears rl:* before the unit run; a bare repeated `npm test` did not,
// which is exactly how this presented (pass-13 lesson).
const runOctet = Math.floor(Math.random() * 250) + 1;

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `10.${runOctet}.${(ipSeq++ % 250) + 1}.1`,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  // Deterministic: this suite exercises the pending-verification flow.
  delete process.env.EMAIL_VERIFY_AUTO;
  // Clean previous runs of this suite.
  await prisma.user.deleteMany({ where: { email: { contains: "@authflow.test" } } });
});

afterAll(async () => {
  if (origVerifyAuto) process.env.EMAIL_VERIFY_AUTO = origVerifyAuto;
  else delete process.env.EMAIL_VERIFY_AUTO;
  await prisma.user.deleteMany({ where: { email: { contains: "@authflow.test" } } });
  await prisma.$disconnect();
});

describe("verification tokens", () => {
  it("are single-use and expire", async () => {
    const raw = await createToken("tok-test@authflow.test", "verify-email");
    const first = await consumeToken("verify-email", raw);
    expect(first.ok).toBe(true);
    expect(first.email).toBe("tok-test@authflow.test");
    expect(await consumeToken("verify-email", raw)).toEqual({ ok: false });

    const raw2 = await createToken("tok-test@authflow.test", "verify-email");
    await prisma.verificationToken.updateMany({
      where: { email: "tok-test@authflow.test", consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await consumeToken("verify-email", raw2)).toEqual({ ok: false });
  });

  it("keeps a just-issued link alive across a re-request, and retires an old one", async () => {
    // Pass 16: a re-request no longer invalidates a token younger than the
    // rotation grace. That is what stops anyone who knows an address from
    // killing each reset link before its owner can click it (/forgot-password
    // needs no session, answers {sent:true} for any address, and allows 5 per 15
    // minutes per account). Both links land in the same mailbox, so nothing is
    // widened by the grace.
    const rawA = await createToken("tok-test@authflow.test", "verify-email");
    const rawB = await createToken("tok-test@authflow.test", "verify-email");
    expect((await consumeToken("verify-email", rawA)).ok).toBe(true);
    expect((await consumeToken("verify-email", rawB)).ok).toBe(true);

    // The property the grace deliberately keeps: once a token is older than it,
    // the next request retires that token, so a stale link in an old mail stops
    // working.
    const rawC = await createToken("tok-test@authflow.test", "verify-email");
    await prisma.verificationToken.updateMany({
      where: { email: "tok-test@authflow.test", purpose: "verify-email", consumedAt: null },
      data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    const rawD = await createToken("tok-test@authflow.test", "verify-email");
    expect(await consumeToken("verify-email", rawC)).toEqual({ ok: false });
    expect((await consumeToken("verify-email", rawD)).ok).toBe(true);
  });
});

describe("registration → email verification", () => {
  it("registers unverified, then verification grants the signup bonus", async () => {
    email = `verify-${Date.now()}@authflow.test`;
    const reg = await registerPOST(
      jsonRequest("http://localhost/api/register", { email, password: "password123", name: "Flow" }),
    );
    const regBody = await reg.json();
    expect(regBody.pendingVerification).toBe(true);
    expect(regBody.credits).toBe(0);
    userId = regBody.userId;

    const user0 = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user0.emailVerified).toBeNull();
    expect(user0.credits).toBe(0);

    const raw = await createToken(email, "verify-email");
    const ver = await verifyEmailPOST(
      jsonRequest("http://localhost/api/auth/verify-email", { token: raw, password: "password123" }),
    );
    const verBody = await ver.json();
    expect(verBody.verified).toBe(true);
    expect(verBody.credits).toBe(30);

    const user1 = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user1.emailVerified).not.toBeNull();
    expect(user1.credits).toBe(30);

    // Same token cannot be reused.
    const again = await verifyEmailPOST(
      jsonRequest("http://localhost/api/auth/verify-email", { token: raw, password: "password123" }),
    );
    expect((await again.json()).ok).toBe(false);
  });

  // Pre-hijacking: POST /api/register takes any address and stores any
  // password, so an attacker can pre-register a victim's address with a
  // password they know. The mailed link alone used to be enough to activate
  // that account, after which the OAuth guard no longer applied (the account
  // was verified, so the victim's own Google sign-in landed in the attacker's
  // account with the attacker's password still working). Verification now
  // needs both halves: the link (mailbox) AND the password (registrant).
  it("refuses to verify without the registrant's password", async () => {
    const victim = `prehijack-${Date.now()}@authflow.test`;
    const reg = await registerPOST(
      jsonRequest("http://localhost/api/register", { email: victim, password: "attacker-pass", name: "?" }),
    );
    const regBody = await reg.json();
    expect(regBody.pendingVerification).toBe(true);

    // The victim clicks the link that arrived in their inbox…
    const raw = await createToken(victim, "verify-email");
    const noPw = await verifyEmailPOST(jsonRequest("http://localhost/api/auth/verify-email", { token: raw }));
    expect((await noPw.json()).error).toBe("invalid-password");
    const wrong = await verifyEmailPOST(
      jsonRequest("http://localhost/api/auth/verify-email", { token: raw, password: "not-the-password" }),
    );
    expect((await wrong.json()).error).toBe("invalid-password");
    // …and neither attempt activates the account or spends the link.
    const still = await prisma.user.findUniqueOrThrow({ where: { email: victim } });
    expect(still.emailVerified).toBeNull();
    expect(still.credits).toBe(0);

    // The registrant (who has the password but not the link) cannot activate it
    // either without the token, and the mailbox owner can always take the
    // account over properly through a password reset.
    const ok = await verifyEmailPOST(
      jsonRequest("http://localhost/api/auth/verify-email", { token: raw, password: "attacker-pass" }),
    );
    expect((await ok.json()).verified).toBe(true);
    await prisma.user.deleteMany({ where: { email: victim } });
  });
});

describe("password reset", () => {
  it("sends a reset token and changes the password once", async () => {
    // forget-password always returns ok, even for unknown accounts. The address
    // is per-run unique: the route charges its per-ADDRESS bucket (5/15min,
    // uniform for unknown addresses so there is no existence oracle) and a
    // fixed one answered 429 by the second `npm test` inside the window — which
    // reads as "no .sent" and looks like a code failure. (The per-run IP octet
    // at the top of the file fixes the same problem on the address leg.)
    const missing = await forgotPOST(
      jsonRequest("http://localhost/api/auth/forgot-password", {
        email: `nobody-${Date.now()}@authflow.test`,
      }),
    );
    expect((await missing.json()).sent).toBe(true);

    const forgot = await forgotPOST(
      jsonRequest("http://localhost/api/auth/forgot-password", { email }),
    );
    expect((await forgot.json()).sent).toBe(true);

    const raw = await createToken(email, "reset-password");
    const reset = await resetPOST(
      jsonRequest("http://localhost/api/auth/reset-password", { token: raw, password: "newpassword456" }),
    );
    expect((await reset.json()).reset).toBe(true);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(await bcrypt.compare("newpassword456", user.passwordHash)).toBe(true);
    expect(await bcrypt.compare("password123", user.passwordHash)).toBe(false);
    // Password reset bumps sessionVersion so older JWTs are rejected.
    expect(user.sessionVersion).toBeGreaterThanOrEqual(1);

    const stale = await resetPOST(
      jsonRequest("http://localhost/api/auth/reset-password", { token: raw, password: "thirdpassword789" }),
    );
    expect((await stale.json()).error).toBe("invalid-token");
    const user2 = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(await bcrypt.compare("newpassword456", user2.passwordHash)).toBe(true);
  });
});

describe("token housekeeping", () => {
  it("purges consumed and expired tokens", async () => {
    const before = await prisma.verificationToken.count();
    await purgeExpiredTokens();
    const after = await prisma.verificationToken.count();
    expect(after).toBeLessThanOrEqual(before);
    // All tokens belonging to this suite are consumed/expired now — except the
    // ones the pass-16 rotation grace deliberately keeps alive (a fresh link
    // survives a re-request, so a request that arrived minutes ago leaves its
    // predecessor usable). The purge's own contract is what this asserts:
    // nothing consumed and nothing expired survives it.
    const leftover = await prisma.verificationToken.findMany({
      where: { email: { contains: "@authflow.test" } },
      select: { consumedAt: true, expiresAt: true },
    });
    expect(leftover.filter((t) => t.consumedAt !== null || t.expiresAt <= new Date())).toEqual([]);
  });
});
