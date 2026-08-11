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
let ipSeq = 100;

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${ipSeq++}.1` },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  // Clean previous runs of this suite.
  await prisma.user.deleteMany({ where: { email: { contains: "@authflow.test" } } });
});

afterAll(async () => {
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

  it("invalidates previous unconsumed tokens for the same email", async () => {
    const rawA = await createToken("tok-test@authflow.test", "verify-email");
    const rawB = await createToken("tok-test@authflow.test", "verify-email");
    expect(await consumeToken("verify-email", rawA)).toEqual({ ok: false });
    expect((await consumeToken("verify-email", rawB)).ok).toBe(true);
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
    const ver = await verifyEmailPOST(jsonRequest("http://localhost/api/auth/verify-email", { token: raw }));
    const verBody = await ver.json();
    expect(verBody.verified).toBe(true);
    expect(verBody.credits).toBe(30);

    const user1 = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user1.emailVerified).not.toBeNull();
    expect(user1.credits).toBe(30);

    // Same token cannot be reused.
    const again = await verifyEmailPOST(jsonRequest("http://localhost/api/auth/verify-email", { token: raw }));
    expect((await again.json()).ok).toBe(false);
  });
});

describe("password reset", () => {
  it("sends a reset token and changes the password once", async () => {
    // forget-password always returns ok, even for unknown accounts.
    const missing = await forgotPOST(
      jsonRequest("http://localhost/api/auth/forgot-password", { email: "nobody@authflow.test" }),
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
    // All tokens belonging to this suite are consumed/expired now.
    const suiteTokens = await prisma.verificationToken.count({
      where: { OR: [{ email: { contains: "@authflow.test" } }, { email: "tok-test@authflow.test" }] },
    });
    expect(suiteTokens).toBe(0);
  });
});
