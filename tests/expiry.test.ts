import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import {
  grantCreditsTx,
  spendCreditsTx,
  refundCreditsTx,
  PACK_VALIDITY_MS,
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

  it("spend with insufficient credits fails atomically", async () => {
    const before = await balance();
    await expect(
      prisma.$transaction((tx) => spendCreditsTx(tx, userId, before + 1, "job", "j4", "overdraft")),
    ).rejects.toThrow("insufficient-credits");
    expect(await balance()).toBe(before);
  });
});
