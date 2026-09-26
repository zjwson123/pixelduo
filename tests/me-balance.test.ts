import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The balance the workbench shows must be the balance the spend path accepts.
// They disagreed for up to a day: spendability ends at expiresAt (lib/ledger.ts
// filters `expiresAt > now()`) while the sweep that zeroes expired grants runs
// DAILY, so inside that window /api/me reported credits that every generation
// refused with "insufficient credits" — the same user, the same session.
const auth = { uid: "" };

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, requireUserId: async () => auth.uid };
});

const { prisma } = await import("../lib/prisma");
const { GET } = await import("../app/api/me/route");
const { runExpiry } = await import("../lib/expiry");

describe("/api/me reports the spendable balance", () => {
  let userId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `me-balance-${Date.now()}@test.dev`, passwordHash: "x", name: "Me Balance", credits: 140 },
    });
    userId = user.id;
    auth.uid = user.id;
    await prisma.creditGrant.createMany({
      data: [
        // Live, spendable.
        { userId, source: "PURCHASE", amount: 40, remaining: 40, expiresAt: new Date(Date.now() + 86_400_000) },
        // Expired but not yet swept — the state a daily sweep leaves behind.
        { userId, source: "PURCHASE", amount: 100, remaining: 100, expiresAt: new Date(Date.now() - 60_000) },
      ],
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: "me-balance-" } } });
    await prisma.$disconnect();
  });

  it("subtracts expired-but-unswept credits and says how many they were", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { credits: number; ledgerCredits: number; expiredCredits: number };
    };
    expect(body.user.credits).toBe(40); // what spendCreditsTx would accept
    expect(body.user.expiredCredits).toBe(100); // named, not hidden
    expect(body.user.ledgerCredits).toBe(140); // the ledger's own balance, on the record
  });

  it("agrees with the ledger once the sweep has run", async () => {
    await runExpiry();
    const res = await GET();
    const body = (await res.json()) as {
      user: { credits: number; ledgerCredits: number; expiredCredits: number };
    };
    expect(body.user.credits).toBe(40);
    expect(body.user.expiredCredits).toBe(0);
    expect(body.user.ledgerCredits).toBe(40);
  });
});
