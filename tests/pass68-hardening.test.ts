import { describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { isFreeTier } from "../scripts/worker";

// Pass-68 pins for two defaults that pointed the permissive way. Neither was a
// live hole: every current caller/authorize branch supplies the value. They are
// the "a guard depends on a field someone else must remember" class passes
// 30/31/37 closed for sv, the second-factor claim and the check-in day key —
// and the second one is the same `??` that pass 31 removed for sv, on the more
// dangerous field.

let seq = 0;
async function makeUser(tag: string) {
  return prisma.user.create({
    data: { email: `p68-${tag}-${Date.now()}-${seq++}@test.dev`, passwordHash: "x", name: tag },
  });
}

type JWT = Record<string, unknown>;

describe("pass 68 — a session cannot be minted without its second-factor claim", () => {
  it("refuses to mint when authorize omitted totpPending", async () => {
    const { authOptions } = await import("../lib/auth");
    const jwt = authOptions.callbacks!.jwt!;
    // Pre-fix `?? false` stamped a FULL session: an account with 2FA enabled
    // would walk straight past TOTP because the default invented the claim the
    // guard reads.
    await expect(
      jwt({ token: {}, user: { id: "u1", sessionVersion: 0 }, account: null } as never),
    ).rejects.toThrow(/without totpPending/);
  });

  it("stamps the boolean claim both ways, and still refuses a missing version first", async () => {
    const { authOptions } = await import("../lib/auth");
    const jwt = authOptions.callbacks!.jwt!;
    for (const pending of [false, true]) {
      const token = (await jwt({
        token: {},
        user: { id: "u1", sessionVersion: 3, totpPending: pending },
        account: null,
      } as never)) as JWT;
      expect(token.totpPending).toBe(pending);
      expect(token.sv).toBe(3);
      expect(token.uid).toBe("u1");
    }
    // The version check stays the first refusal (pass 31): its message is what
    // tells an operator which authorize branch broke.
    await expect(
      jwt({ token: {}, user: { id: "u1", totpPending: false }, account: null } as never),
    ).rejects.toThrow(/without sessionVersion/);
  });
});

describe("pass 68 — a live token must be able to prove its second-factor state", () => {
  it("strips the identity off a token that carries an id and a live sv but no boolean claim", async () => {
    const user = await makeUser("jwt-claim");
    const live = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { sessionVersion: true },
    });
    const { authOptions } = await import("../lib/auth");
    const jwt = authOptions.callbacks!.jwt!;
    // Every shape a non-current mint (or a hand-built cookie) can produce. A
    // string "false" is the dangerous one: it is truthy to some readers and
    // falsy to others, so only a real boolean proves the state.
    for (const claim of [undefined, "false", "true", 0, 1, null]) {
      const token: JWT = { uid: user.id, sv: live.sessionVersion, sub: user.id, email: user.email };
      if (claim !== undefined) token.totpPending = claim;
      const returned = (await jwt({ token, user: undefined, account: null } as never)) as JWT;
      expect(returned.uid, String(claim)).toBeUndefined();
      expect(returned.sv, String(claim)).toBeUndefined();
      expect(returned.totpPending, String(claim)).toBeUndefined();
      expect(returned.sub, String(claim)).toBeUndefined();
    }
  });

  it("keeps a live token that carries the boolean claim — both values", async () => {
    const user = await makeUser("jwt-keep");
    const live = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { sessionVersion: true },
    });
    const { authOptions } = await import("../lib/auth");
    const jwt = authOptions.callbacks!.jwt!;
    for (const pending of [false, true]) {
      const returned = (await jwt({
        token: { uid: user.id, sv: live.sessionVersion, totpPending: pending },
        user: undefined,
        account: null,
      } as never)) as JWT;
      expect(returned.uid).toBe(user.id);
      expect(returned.totpPending).toBe(pending);
    }
  });
});

describe("pass 68 — the watermark tier is decided on the clock it is handed", () => {
  it("flips exactly at the cycle boundary the caller supplies, never on the process clock", () => {
    const boundary = new Date("2026-01-01T00:00:00.000Z");
    const user = { plan: "pro", planRenewsAt: boundary };
    // One millisecond before the boundary: in cycle, clean output.
    expect(isFreeTier(user, new Date(boundary.getTime() - 1))).toBe(false);
    // At and after it: lapsed, watermarked. The parameter is required now, so a
    // future caller cannot fall back to this process's `new Date()`.
    expect(isFreeTier(user, new Date(boundary.getTime()))).toBe(true);
    expect(isFreeTier(user, new Date(boundary.getTime() + 86_400_000))).toBe(true);
  });
});
