import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { signupBonus, adminGrantTx, adminClawbackTx, grantCreditsTx } from "../lib/ledger";

let userId: string;

async function balance(): Promise<number> {
  return (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
}

async function sumRemaining(): Promise<number> {
  const rows = await prisma.creditGrant.findMany({ where: { userId }, select: { remaining: true } });
  return rows.reduce((a, g) => a + g.remaining, 0);
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `admin-${Date.now()}@test.dev`, passwordHash: "x", name: "Admin Test" },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "admin-" } } });
  await prisma.$disconnect();
});

describe("admin credit adjustments", () => {
  it("grants and claws back while preserving the invariant", async () => {
    await signupBonus(userId); // 30 free
    await prisma.$transaction((tx) =>
      grantCreditsTx(tx, userId, "PURCHASE", 400, new Date(Date.now() + 365 * 24 * 3600 * 1000), "order", "o1", "pack"),
    );

    await prisma.$transaction((tx) => adminGrantTx(tx, userId, 100, "compensation", "admin-test"));
    expect(await balance()).toBe(530);
    expect(await balance()).toBe(await sumRemaining());

    // Clawback 40 → free/admin pool (30 + 100) shrinks first; PURCHASE untouched.
    await prisma.$transaction((tx) => adminClawbackTx(tx, userId, 40, "abuse deduction", "admin-test"));
    expect(await balance()).toBe(490);
    expect(await balance()).toBe(await sumRemaining());
    const purchase = await prisma.creditGrant.findFirstOrThrow({ where: { userId, source: "PURCHASE" } });
    expect(purchase.remaining).toBe(400);
    const signup = await prisma.creditGrant.findFirstOrThrow({ where: { userId, source: "SIGNUP_BONUS" } });
    expect(signup.remaining).toBe(0); // oldest free grant consumed first
    const admin = await prisma.creditGrant.findFirstOrThrow({ where: { userId, source: "ADMIN" } });
    expect(admin.remaining).toBe(90);
  });

  it("rejects clawback beyond available balance", async () => {
    await expect(
      prisma.$transaction((tx) => adminClawbackTx(tx, userId, 999_999, "too much", "admin-test")),
    ).rejects.toThrow("insufficient-credits");
    expect(await balance()).toBe(await sumRemaining());
  });
});
