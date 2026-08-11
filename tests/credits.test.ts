import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { grantCreditsTx } from "../lib/ledger";
import { listExpiringCredits } from "../lib/credits";

let userId: string;

async function addGrant(source: string, remaining: number, expiresInDays: number) {
  const expiresAt =
    expiresInDays === -1 ? null : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  await prisma.$transaction((tx) =>
    grantCreditsTx(tx, userId, source as never, remaining, expiresAt, "order", "o", "test"),
  );
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `credits-${Date.now()}@test.dev`, passwordHash: "x", name: "Credits Test" },
  });
  userId = user.id;
  await addGrant("PURCHASE", 400, 3);
  await addGrant("PURCHASE", 100, 20); // outside the 14-day horizon
  await addGrant("SIGNUP_BONUS", 30, 5); // free source never expires/ignored
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "credits-" } } });
  await prisma.$disconnect();
});

describe("expiring credits", () => {
  it("lists only paid grants expiring within the horizon", async () => {
    const expiring = await listExpiringCredits(userId);
    expect(expiring).toHaveLength(1);
    expect(expiring[0].remaining).toBe(400);
    expect(expiring[0].daysLeft).toBe(3);
  });
});
