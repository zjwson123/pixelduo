import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../lib/prisma";
import { ensureOAuthUser, authOptions } from "../lib/auth";

const signIn = authOptions.callbacks!.signIn!;

const EMAIL = `oauth-${Date.now()}@test.dev`;

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "oauth-" } } });
  await prisma.$disconnect();
});

describe("OAuth account provisioning", () => {
  // The third argument is the provider's verdict on the address, and only an
  // explicit `true` creates or links an account (lib/auth.ts): the default is
  // refusal, so these cases state the vouching they rely on instead of leaving
  // it implied.
  it("creates a verified account with signup bonus on first sign-in", async () => {
    const user = await ensureOAuthUser(EMAIL, "OAuth User", true);
    expect(user).not.toBeNull();
    const db = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(db.emailVerified).not.toBeNull();
    expect(db.credits).toBe(30);
    expect(db.passwordHash).not.toBe(""); // placeholder hash, no usable password
  });

  it("reuses the existing account without double-granting", async () => {
    await ensureOAuthUser(EMAIL, "OAuth User", true);
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
    expect(await ensureOAuthUser(email, "Victim OAuth", true)).toBeNull();
    const db = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(db.emailVerified).toBeNull(); // not auto-verified by the attempt
  });

  // Silence is not consent: a caller that supplies no verdict (or a resolver
  // that gave up) must not be the difference between a refusal and an
  // auto-verified account, so the default argument refuses.
  it("refuses when no provider verdict is supplied", async () => {
    const email = `oauth-noclaim-${Date.now()}@test.dev`;
    await prisma.user.create({
      data: { email, passwordHash: "victim-hash", name: "Victim", emailVerified: new Date() },
    });
    expect(await ensureOAuthUser(email, "No Claim")).toBeNull();
    expect(await ensureOAuthUser(email, "Null Claim", null as never)).toBeNull();
    expect(await prisma.user.findUniqueOrThrow({ where: { email } })).toBeTruthy();
  });

  it("accepts an explicitly verified provider email", async () => {
    const email = `oauth-ver-${Date.now()}@test.dev`;
    expect(await ensureOAuthUser(email, "Verified Claim", true)).not.toBeNull();
    const db = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(db.emailVerified).not.toBeNull();
  });
});

// GitHub publishes no `email_verified` claim, and NextAuth's GitHub provider
// builds `profile.email` from /user/emails as `primary ?? emails[0]` WITHOUT
// looking at the `verified` flag. The signIn callback treated a missing claim as
// "the provider vouches for this address", so an address the attacker merely
// added to their own GitHub account would auto-link them into the real owner's
// (already verified) account — full session, no password, no second factor.
describe("GitHub sign-in requires a verified address", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubGithubEmails(list: Array<{ email: string; verified: boolean; primary?: boolean }>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(list), { status: 200 })),
    );
  }

  async function githubSignIn(email: string): Promise<boolean> {
    return (await signIn({
      user: { id: "gh-1", email, name: "GH" },
      account: { type: "oauth", provider: "github", access_token: "tok" },
      profile: {},
    } as never)) as boolean;
  }

  it("refuses an address GitHub reports as unverified", async () => {
    const email = `oauth-gh-unv-${Date.now()}@test.dev`;
    await prisma.user.create({
      data: { email, passwordHash: "victim-hash", name: "Victim", emailVerified: new Date() },
    });
    stubGithubEmails([{ email, verified: false, primary: true }]);
    expect(await githubSignIn(email)).toBe(false);
  });

  it("refuses when GitHub does not list the address at all", async () => {
    const email = `oauth-gh-absent-${Date.now()}@test.dev`;
    await prisma.user.create({
      data: { email, passwordHash: "victim-hash", name: "Victim", emailVerified: new Date() },
    });
    stubGithubEmails([{ email: "someone-else@test.dev", verified: true }]);
    expect(await githubSignIn(email)).toBe(false);
  });

  it("refuses when the provider API cannot be reached", async () => {
    const email = `oauth-gh-down-${Date.now()}@test.dev`;
    await prisma.user.create({
      data: { email, passwordHash: "victim-hash", name: "Victim", emailVerified: new Date() },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await githubSignIn(email)).toBe(false);
  });

  it("accepts an address GitHub reports as verified", async () => {
    const email = `oauth-gh-ok-${Date.now()}@test.dev`;
    await prisma.user.create({
      data: { email, passwordHash: "victim-hash", name: "Victim", emailVerified: new Date() },
    });
    stubGithubEmails([{ email, verified: true, primary: true }]);
    expect(await githubSignIn(email)).toBe(true);
  });
});

