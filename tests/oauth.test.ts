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
});
