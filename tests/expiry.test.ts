import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import {
  grantCreditsTx,
  spendCreditsTx,
  refundCreditsTx,
  PACK_VALIDITY_MS,
  REFUND_REPLACEMENT_TTL_MS,
} from "../lib/ledger";
import { runExpiry } from "../lib/expiry";

let userId: string;

async function balance() {
  return (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).credits;
}

async function grantRemaining(source: string): Promise<number> {
  const grants = await prisma.creditGrant.findMany({ where: { userId, source } });
  return grants.reduce((a, g) => a + g.remaining, 0);
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `expiry-${Date.now()}@test.dev`, passwordHash: "x", name: "Expiry Test" },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: "expiry-" } } });
  await prisma.$disconnect();
});

describe("credit grants & expiry", () => {
  it("free credits are consumed before paid credits", async () => {
    await prisma.$transaction(async (tx) => {
      await grantCreditsTx(tx, userId, "SIGNUP_BONUS", 30, null);
      await grantCreditsTx(tx, userId, "PURCHASE", 1000, new Date(Date.now() + PACK_VALIDITY_MS));
    });
    expect(await balance()).toBe(1030);
    const consumption = await prisma.$transaction((tx) =>
      spendCreditsTx(tx, userId, 40, "job", "j1", "test spend"),
    );
    // 30 from free + 10 from the paid pack
    expect(await grantRemaining("SIGNUP_BONUS")).toBe(0);
    expect(await grantRemaining("PURCHASE")).toBe(990);
    expect(consumption).toHaveLength(2);
    expect(consumption[0].amount).toBe(30);
    expect(consumption[1].amount).toBe(10);
  });

  it("refund restores the exact grants (expiry preserved)", async () => {
    const before = await balance();
    const consumption = await prisma.$transaction((tx) =>
      spendCreditsTx(tx, userId, 20, "job", "j2", "test spend 2"),
    );
    await prisma.$transaction((tx) =>
      refundCreditsTx(tx, userId, 20, consumption, "job", "j2", "test refund"),
    );
    expect(await balance()).toBe(before);
    expect(await grantRemaining("PURCHASE")).toBe(990);
  });

  it("a refund for a grant that expired mid-retry lands in a fresh, bounded grant", async () => {
    // Refunding into the dead grant would hand the expiry sweep a fresh
    // remaining>0 row on an expired grant — the sweep zeroes it and deducts
    // the refund right back out of the balance (user silently loses it).
    // The replacement is deliberately NOT permanent: an unbounded one lets a
    // user withhold credits that are about to expire (submit a job seconds
    // before the deadline) and convert them into credits the sweep can never
    // touch, farming a known expiry over and over.
    // Uses its own user so the cumulative assertions below are unaffected.
    const u = await prisma.user.create({
      data: { email: `expiry-refund-${Date.now()}@test.dev`, passwordHash: "x" },
    });
    try {
      const bal = () => prisma.user.findUniqueOrThrow({ where: { id: u.id } }).then((x) => x.credits);
      const soon = new Date(Date.now() + 2000);
      const consumption = await prisma.$transaction(async (tx) => {
        await grantCreditsTx(tx, u.id, "PURCHASE", 50, soon);
        return spendCreditsTx(tx, u.id, 50, "job", "j-exp-refund", "spend before expiry");
      });
      expect(consumption).toHaveLength(1);
      const before = await bal();
      await new Promise((r) => setTimeout(r, 2100)); // grant crosses expiresAt
      await prisma.$transaction((tx) =>
        refundCreditsTx(tx, u.id, 50, consumption, "job", "j-exp-refund", "late refund"),
      );
      expect(await bal()).toBe(before + 50);
      const replacement = await prisma.creditGrant.findFirstOrThrow({
        where: { userId: u.id, source: "REFUND" },
      });
      expect(replacement.remaining).toBe(50);
      // Bounded, and comfortably in the future: long enough that an ordinary
      // failure is refunded well before it lapses, short enough that holding
      // credits across an expiry stops being profitable.
      expect(replacement.expiresAt).not.toBeNull();
      expect(replacement.expiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect(replacement.expiresAt!.getTime()).toBeLessThanOrEqual(
        Date.now() + REFUND_REPLACEMENT_TTL_MS,
      );
      // The sweep must not claw it back out: the replacement is not expired,
      // so the daily run has nothing to destroy.
      await runExpiry();
      expect(await bal()).toBe(before + 50);
      // And the refund grant is spendable (invariant: credits == SUM(remaining)).
      await prisma.$transaction((tx) =>
        spendCreditsTx(tx, u.id, 50, "job", "j-exp-refund-2", "spend replacement"),
      );
      expect(await bal()).toBe(before);
    } finally {
      await prisma.user.deleteMany({ where: { id: u.id } });
    }
  });

  it("spends earliest-expiring paid grants first", async () => {
    const soon = new Date(Date.now() + 7 * 24 * 3600_000);
    const later = new Date(Date.now() + PACK_VALIDITY_MS);
    await prisma.$transaction(async (tx) => {
      await grantCreditsTx(tx, userId, "PURCHASE", 100, soon);
      await grantCreditsTx(tx, userId, "PURCHASE", 100, later);
    });
    await prisma.$transaction((tx) => spendCreditsTx(tx, userId, 120, "job", "j3", "fifo"));
    const grants = await prisma.creditGrant.findMany({
      where: { userId, source: "PURCHASE" },
      orderBy: { expiresAt: "asc" },
    });
    expect(grants[0].remaining).toBe(0); // earlier-expiring pack consumed first (100/100)
    expect(grants[1].remaining).toBe(970); // 20 taken from the earliest 12-month pack
    expect(grants[2].remaining).toBe(100); // second 12-month pack untouched
  });

  it("expired grants are swept with an EXPIRE ledger entry", async () => {
    const past = new Date(Date.now() - 1000);
    await prisma.$transaction((tx) => grantCreditsTx(tx, userId, "PURCHASE", 500, past));
    const before = await balance();
    const expired = await runExpiry();
    expect(expired).toBeGreaterThanOrEqual(500);
    expect(await balance()).toBe(before - 500);
    // the expired pack is zeroed (still counted with remaining 0); others intact
    expect(await grantRemaining("PURCHASE")).toBe(1070);
    const expiredGrant = await prisma.creditGrant.findFirst({
      where: { userId, source: "PURCHASE", expiresAt: { lte: new Date() } },
    });
    expect(expiredGrant?.remaining).toBe(0);
    const entry = await prisma.ledgerEntry.findFirst({
      where: { userId, type: "EXPIRE" },
      orderBy: { createdAt: "desc" },
    });
    expect(entry?.creditsDelta).toBe(-500);
    expect(entry?.balanceAfter).toBe(before - 500);
  });

  it("expired credits are unspendable even before the sweep runs", async () => {
    // The daily sweep is bookkeeping; spendability must end at expiresAt.
    const before = await balance();
    // Drain every unexpired grant first…
    await prisma.$transaction((tx) =>
      spendCreditsTx(tx, userId, before, "job", "j-drain", "drain unexpired"),
    );
    // …so the balance below comes ONLY from an expired grant.
    const past = new Date(Date.now() - 1000);
    await prisma.$transaction((tx) => grantCreditsTx(tx, userId, "PURCHASE", 777, past));
    expect(await balance()).toBe(777);
    await expect(
      prisma.$transaction((tx) => spendCreditsTx(tx, userId, 1, "job", "j-exp", "expired spend")),
    ).rejects.toThrow("insufficient-credits");
    // Sweep the expired grant so the final assertions below see balance 0.
    await runExpiry();
    expect(await balance()).toBe(0);
  });

  it("spend with insufficient credits fails atomically", async () => {
    const before = await balance();
    await expect(
      prisma.$transaction((tx) => spendCreditsTx(tx, userId, before + 1, "job", "j4", "overdraft")),
    ).rejects.toThrow("insufficient-credits");
    expect(await balance()).toBe(before);
  });
});
