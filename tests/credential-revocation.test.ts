import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";

// The 2FA route guards need a session; the rest of auth is real.
const getServerSession = vi.fn();
vi.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));

const { POST: confirmTwoFactor } = await import("../app/api/2fa/confirm/route");
const { POST: disableTwoFactor } = await import("../app/api/2fa/disable/route");
const { prisma } = await import("../lib/prisma");
const { createApiKey, authenticateApiKey } = await import("../lib/apikey");
const { generateTwoFactorSetup, _resetTwoFaForTests } = await import("../lib/twofa");

// authenticateApiKey writes lastUsedAt; keep tests off that path.
const bearer = (key: string) => new Request("http://localhost/api/x", { headers: { authorization: `Bearer ${key}` } });

let userId: string;
const email = `apikey-2fa-${Date.now()}@test.dev`;
const password = "correct-horse-battery-staple";

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: bcrypt.hashSync(password, 10),
      emailVerified: new Date(),
      name: "Credential Revocation Test",
    },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email } });
  _resetTwoFaForTests();
  await prisma.$disconnect();
});

// Enabling 2FA is the remediation the product tells a user who sees suspicious
// activity to perform, and it bumps sessionVersion so every stolen session
// dies. authenticateApiKey never consults sessionVersion, so a key minted with
// a guessed password before 2FA was on used to survive the hardening entirely —
// no expiry, one per 20/min budget, spending the victim's credits forever.
describe("credential revocation on 2FA enablement", () => {
  it("revokes existing API keys so a pre-2FA credential does not outlive the change", async () => {
    const setup = await generateTwoFactorSetup(email);
    const user = await prisma.user.update({
      where: { id: userId },
      data: { totpPendingSecret: setup.secret },
    });

    const key = await createApiKey(userId, "minted-before-2fa", user.sessionVersion);
    expect((await authenticateApiKey(bearer(key.key)))?.userId).toBe(userId);

    getServerSession.mockResolvedValue({
      user: { id: userId, sv: user.sessionVersion, totpPending: false },
    });
    const res = await confirmTwoFactor(
      new Request("http://localhost/api/2fa/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
        body: JSON.stringify({ token: authenticator.generate(setup.secret), password }),
      }),
    );
    expect(res.status).toBe(200);

    const enabled = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(enabled.totpEnabled).toBe(true);
    expect(enabled.sessionVersion).toBe(user.sessionVersion + 1);
    // The parallel credential is gone.
    expect(await authenticateApiKey(bearer(key.key))).toBeNull();
    const rec = await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } });
    expect(rec.revokedAt).not.toBeNull();
  });

  // Turning 2FA OFF is a downgrade, and it was the only security-state
  // transition in the codebase that revoked nothing: every session minted while
  // 2FA was on stayed valid (no sessionVersion bump) and every pd_live_ key kept
  // working (authenticateApiKey never reads sessionVersion at all). The account
  // lands in exactly the state an attacker wants, with all their credentials
  // intact.
  it("revokes sessions and API keys when 2FA is disabled", async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(before.totpEnabled).toBe(true);

    const key = await createApiKey(userId, "minted-while-2fa-on", before.sessionVersion);
    expect((await authenticateApiKey(bearer(key.key)))?.userId).toBe(userId);

    getServerSession.mockResolvedValue({
      user: { id: userId, sv: before.sessionVersion, totpPending: false },
    });
    const res = await disableTwoFactor(
      new Request("http://localhost/api/2fa/disable", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.8" },
        body: JSON.stringify({ token: authenticator.generate(before.totpSecret!), password }),
      }),
    );
    expect(res.status).toBe(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.totpEnabled).toBe(false);
    expect(after.totpSecret).toBeNull();
    expect(after.sessionVersion).toBe(before.sessionVersion + 1);
    expect(await authenticateApiKey(bearer(key.key))).toBeNull();
    const rec = await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } });
    expect(rec.revokedAt).not.toBeNull();
  });
});
