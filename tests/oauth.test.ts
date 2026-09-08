import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { ensureOAuthUser } from "../lib/auth";

const EMAIL = `oauth-${Date.now()}@test.dev`;

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "oauth-" } } });
  await prisma.$disconnect();
});

describe("OAuth account provisioning", () => {
  it("creates a verified account with signup bonus on first sign-in", async () => {
    const user = await ensureOAuthUser(EMAIL, "OAuth User");
    expect(user).not.toBeNull();
    const db = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(db.emailVerified).not.toBeNull();
    expect(db.credits).toBe(30);
    expect(db.passwordHash).not.toBe(""); // placeholder hash, no usable password
  });

  it("reuses the existing account without double-granting", async () => {
    await ensureOAuthUser(EMAIL, "OAuth User");
    const db = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(db.credits).toBe(30);
  });

  it("rejects missing emails", async () => {
    expect(await ensureOAuthUser("", "No Email")).toBeNull();
  });

  it("rejects a provider-reported unverified email without creating an account", async () => {
    const email = `oauth-unv-${Date.now()}@test.dev`;
    expect(await ensureOAuthUser(email, "Unverified Claim", false)).toBeNull();
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("refuses to claim an unverified password-registered account (pre-hijacking)", async () => {
    // Simulate POST /api/register with a victim address the attacker doesn't
    // own (no verification ever completed): OAuth sign-in for that address
    // must NOT link into — and auto-verify — that account.
    const email = `oauth-prehijack-${Date.now()}@test.dev`;
    await prisma.user.create({
      data: { email, passwordHash: "attacker-hash", name: "Attacker Pre-Reg" },
    });
    expect(await ensureOAuthUser(email, "Victim OAuth")).toBeNull();
    const db = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(db.emailVerified).toBeNull(); // not auto-verified by the attempt
  });

  it("accepts an explicitly verified provider email", async () => {
    const email = `oauth-ver-${Date.now()}@test.dev`;
    expect(await ensureOAuthUser(email, "Verified Claim", true)).not.toBeNull();
    const db = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(db.emailVerified).not.toBeNull();
  });
});
