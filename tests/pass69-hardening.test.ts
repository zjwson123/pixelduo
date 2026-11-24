import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../lib/prisma";

// Pass-69 pins. Three small things this pass changed, each of which is invisible
// to a happy-path test:
//
//  1. A pre-CHECK grant row whose `amount` is NEGATIVE (the state
//     scripts/repair-credit-invariant.ts exists for) used to brick spending.
//     writeOffExcessTx zeroed the row, the spend loop then assigned the STALE
//     negative ceiling back and decremented by it, and the resulting row
//     (remaining 5, amount 0) broke CreditGrant_remaining_range — aborting the
//     whole transaction, repair included, on every attempt. The account could
//     not generate, be refunded or be clawed back.
//  2. The hosted-checkout URL is the one provider value the browser NAVIGATES
//     to (`window.location = …`), so a non-http(s) scheme must never be handed
//     to it.
//  3. sessionUser's `totpPending ?? false` was the last permissive default on a
//     second-factor gate; a session that cannot prove the claim is refused now.
const sessionMock = vi.fn();
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: (...args: unknown[]) => sessionMock(...args) };
});

const { spendCreditsTx } = await import("../lib/ledger");
const { checkoutDestinationUrl } = await import("../lib/payments");
const { sessionUser } = await import("../lib/api");

const stamp = Date.now();
let userId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `p69-${stamp}@test.dev`, passwordHash: "not-a-real-hash", credits: 12 },
  });
  userId = user.id;
  // The corrupt row can only exist in data written BEFORE the CHECK was added:
  // the constraint is NOT VALID for existing rows but is enforced on every
  // INSERT/UPDATE. Simulate that legacy state by dropping the constraint for
  // the INSERT and restoring it in the SAME transaction — a crash cannot leave
  // the table unguarded, and `IF EXISTS` repairs a constraint a previous
  // interrupted run left missing.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'ALTER TABLE "CreditGrant" DROP CONSTRAINT IF EXISTS "CreditGrant_remaining_range"',
    );
    await tx.creditGrant.create({
      data: { userId, source: "PURCHASE", amount: -5, remaining: 2 },
    });
    await tx.$executeRawUnsafe(
      'ALTER TABLE "CreditGrant" ADD CONSTRAINT "CreditGrant_remaining_range" CHECK ("remaining" >= 0 AND "remaining" <= "amount") NOT VALID',
    );
  });
  // The backed lot, in the free class so it is drawn first (GRANT_LOCK_ORDER).
  await prisma.creditGrant.create({ data: { userId, source: "CHECKIN", amount: 10, remaining: 10 } });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: `p69-${stamp}` } } });
  await prisma.$disconnect();
});

describe("pass 69 — a negative-amount grant cannot brick spending", () => {
  it("answers insufficient-credits instead of aborting on the CHECK constraint", async () => {
    // 12 asked, 10 backed: the loop drains the healthy lot and then reaches the
    // corrupt row, which the repair writes off. Before the fix the same path
    // threw SQLSTATE 23514 (remaining 5 > amount 0) — an UNEXPECTED error, so a
    // real spend route answered a masked 500 and captured an incident, forever.
    await expect(
      prisma.$transaction((tx) => spendCreditsTx(tx, userId, 12, "job", `p69-${stamp}-over`)),
    ).rejects.toThrow(/insufficient-credits/);
  });

  it("still spends the credits that are actually backed", async () => {
    const consumption = await prisma.$transaction((tx) =>
      spendCreditsTx(tx, userId, 10, "job", `p69-${stamp}-ok`),
    );
    expect(consumption.reduce((sum, c) => sum + c.amount, 0)).toBe(10);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.credits).toBe(2);
  });
});

describe("pass 69 — a checkout destination is an absolute http(s) URL", () => {
  it("accepts the two schemes a browser may be navigated to", () => {
    expect(checkoutDestinationUrl("https://checkout.stripe.com/c/pay/cs_test_abc")).toBe(
      "https://checkout.stripe.com/c/pay/cs_test_abc",
    );
    expect(checkoutDestinationUrl("http://127.0.0.1:18000/pay/psp")).toBe("http://127.0.0.1:18000/pay/psp");
    // The URL parser canonicalises, which is what the browser will also act on.
    expect(checkoutDestinationUrl("HTTPS://PAY.PADDLE.IO/x")).toBe("https://pay.paddle.io/x");
  });

  it("refuses every scheme that would run in this origin or nowhere", () => {
    // A provider response is untrusted: assigning this to window.location
    // executes it with the buyer's session (CSP allows inline script).
    expect(checkoutDestinationUrl("javascript:alert(document.cookie)")).toBeNull();
    expect(checkoutDestinationUrl(" JaVaScRiPt:alert(1)")).toBeNull();
    expect(checkoutDestinationUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(checkoutDestinationUrl("vbscript:msgbox(1)")).toBeNull();
    expect(checkoutDestinationUrl("//evil.example/pay")).toBeNull();
    expect(checkoutDestinationUrl("/studio?paid=1&mockOrder=1")).toBeNull();
    expect(checkoutDestinationUrl("")).toBeNull();
    expect(checkoutDestinationUrl("not a url")).toBeNull();
  });
});

describe("pass 69 — a session that cannot prove its second-factor state is refused", () => {
  it("refuses a session with no totpPending claim (the permissive default is gone)", async () => {
    sessionMock.mockResolvedValue({ user: { id: "u1", sv: 0 } });
    await expect(sessionUser()).rejects.toMatchObject({ status: 401 });
  });

  it("keeps both boolean states intact for the callers that distinguish them", async () => {
    sessionMock.mockResolvedValue({ user: { id: "u1", sv: 3, totpPending: true } });
    await expect(sessionUser()).resolves.toEqual({ id: "u1", sv: 3, totpPending: true });
    sessionMock.mockResolvedValue({ user: { id: "u1", sv: 3, totpPending: false } });
    await expect(sessionUser()).resolves.toEqual({ id: "u1", sv: 3, totpPending: false });
  });
});
