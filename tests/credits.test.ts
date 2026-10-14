import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { grantCreditsTx } from "../lib/ledger";
import { listExpiringCredits } from "../lib/credits";

let userId: string;

// An hour INSIDE the requested day, not on its boundary (pass 37). daysLeft is
// Math.ceil'd against the DATABASE's now() while the fixture is built from the
// host clock: a database clock a few ms behind the host turned "3 days" into 4
// (probed — this file failed in a full-suite run and passed alone) and made
// "1 day" read as 2, i.e. a different reminder bucket. vitest.setup.ts refuses
// only past 1000ms of skew, so the margin is what makes the fixture state what
// the test means.
async function addGrant(source: string, remaining: number, expiresInDays: number) {
  const expiresAt =
    expiresInDays === -1
      ? null
      : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000 - 60 * 60 * 1000);
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

  // An already-expired grant that has not been swept yet is unspendable
  // (spendCreditsTx refuses it), so the banner must not advertise it as a live
  // countdown — daysLeft is clamped to a minimum of 1, which made expired
  // credits read as "1 day left". The reminder path already filtered these.
  it("does not advertise credits that have already expired", async () => {
    await addGrant("PURCHASE", 77, -2); // expired two days ago, not yet swept
    const expiring = await listExpiringCredits(userId);
    expect(expiring.map((g) => g.remaining)).not.toContain(77);
    expect(expiring).toHaveLength(1);
    expect(expiring[0].remaining).toBe(400);
  });
});
