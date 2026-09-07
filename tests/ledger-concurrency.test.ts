import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { addCreditsTx, grantCreditsTx, spendCreditsTx } from "../lib/ledger";

// Regression: addCreditsTx used to do a read-modify-write of User.credits and
// overwrite with an absolute value, so a grant racing a concurrent spend could
// lose one side's delta. All writers now go through an atomic increment.
let userId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `ledger-conc-${Date.now()}@test.dev`, passwordHash: "x", name: "Ledger Concurrency" },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "ledger-conc-" } } });
  await prisma.$disconnect();
});

describe("concurrent ledger writes", () => {
  it("never loses updates when grants race each other", async () => {
    // 20 parallel +2 grants from a zero balance must land all 20 increments.
    await Promise.all(
      Array.from({ length: 20 }, () =>
        prisma.$transaction((tx) => grantCreditsTx(tx, userId, "CHECKIN", 2, null, "test", null, "race grant")),
      ),
    );
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.credits).toBe(40);
    const entries = await prisma.ledgerEntry.findMany({ where: { userId, type: "CHECKIN" } });
    expect(entries).toHaveLength(20);
  });

  it("keeps credits == SUM(remaining) when spends race grants", async () => {
    // Spends lock the grant rows; fresh grants take no such lock, so this
    // interleaving is exactly where the old overwrite dropped updates.
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 8; i++) {
      ops.push(
        i % 2 === 0
          ? prisma.$transaction((tx) => spendCreditsTx(tx, userId, 3, "test", null, "race spend"))
          : prisma.$transaction((tx) => grantCreditsTx(tx, userId, "CHECKIN", 5, null, "test", null, "race grant")),
      );
    }
    await Promise.all(ops);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.credits).toBe(40 + 4 * 5 - 4 * 3);
    const grants = await prisma.creditGrant.findMany({ where: { userId } });
    expect(user.credits).toBe(grants.reduce((acc, g) => acc + g.remaining, 0));
    const entries = await prisma.ledgerEntry.findMany({ where: { userId } });
    expect(entries.every((e) => e.balanceAfter >= 0)).toBe(true);
  });
});
