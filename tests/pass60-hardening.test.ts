import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

// Pass 60.
//
//   1. /api/account/export promised "可导出您的全部数据" but omitted the
//      account's Checkin history — the one user-owned table (a userId FK) the
//      export never selected, and the one fact the ledger cannot reconstruct
//      (it records the credit movement, not which days were claimed).
//   2. /api/auth/revoke-sessions bumped sessionVersion and revoked API keys,
//      but left outstanding verification / password-reset links alive for
//      their full 1h / 24h TTL. "Sign out everywhere" is what an owner does
//      after suspecting a compromised mailbox or browser, and a link requested
//      before that revocation outlived it (a completed /reset-password already
//      retires these; this was the sibling remediation).
//   3. The erasure routes (self-service and admin) wiped the no-FK ApiKey and
//      CreditReminder tables explicitly but not PaymentEvent — also no FK to
//      Order — so the account's provider/event/amount trail survived an
//      erasure no row connected it to.

const getServerSession = vi.fn();
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: (...args: unknown[]) => getServerSession(...args) };
});

const { prisma } = await import("../lib/prisma");
const { POST: exportPost } = await import("../app/api/account/export/route");
const { POST: revokeSessionsPost } = await import("../app/api/auth/revoke-sessions/route");
const { POST: deletePost } = await import("../app/api/account/delete/route");
const { DELETE: adminDelete } = await import("../app/api/admin/users/[id]/route");

let seq = 0;
const tag = `pass60-${Date.now()}`;

async function makeUser(extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: { email: `${tag}-${seq++}@test.dev`, passwordHash: bcrypt.hashSync("pass60-password", 4), name: "Pass 60", ...extra },
  });
}

function session(user: { id: string }, sv = 0) {
  getServerSession.mockResolvedValue({ user: { id: user.id, sv, totpPending: false } });
}

function jsonRequest(url: string, body?: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function callJson(handler: (req: Request) => Promise<Response>, body?: unknown) {
  const res = await handler(jsonRequest("http://localhost/api/test", body));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(() => {
  getServerSession.mockReset();
});

afterEach(() => {
  getServerSession.mockReset();
});

afterAll(async () => {
  await prisma.paymentEvent.deleteMany({ where: { orderId: { in: (await prisma.order.findMany({ where: { user: { email: { startsWith: tag } } }, select: { id: true } })).map((o) => o.id) } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } });
  await prisma.$disconnect();
});

describe("pass 60 — the data export includes the check-in history", () => {
  it("returns every claimed check-in day and its credits", async () => {
    const user = await makeUser();
    const today = new Date().toISOString().slice(0, 10);
    const older = new Date(Date.now() - 2 * 24 * 3600_000).toISOString().slice(0, 10);
    await prisma.checkin.createMany({
      data: [
        { userId: user.id, date: older, credits: 2 },
        { userId: user.id, date: today, credits: 2 },
      ],
    });
    session(user);
    const { status, body } = await callJson(exportPost);
    expect(status).toBe(200);
    const data = body.data as {
      checkins: Array<{ date: string; credits: number }>;
      user: { id: string };
    };
    expect(data.user.id).toBe(user.id);
    expect(data.checkins.map((c) => c.date)).toEqual([older, today]);
    expect(data.checkins.every((c) => c.credits === 2)).toBe(true);
  });
});

describe("pass 60 — revoke-sessions retires outstanding auth links", () => {
  it("consumes this account's live reset/verify tokens and leaves a neighbour's alone", async () => {
    const user = await makeUser();
    const other = await makeUser();
    const now = new Date();
    await prisma.verificationToken.createMany({
      data: [
        { email: user.email, userId: user.id, purpose: "reset-password", tokenHash: `${tag}-reset-${user.id}`, expiresAt: new Date(now.getTime() + 3600_000) },
        { email: user.email, userId: user.id, purpose: "verify-email", tokenHash: `${tag}-verify-${user.id}`, expiresAt: new Date(now.getTime() + 86_400_000) },
        { email: other.email, userId: other.id, purpose: "reset-password", tokenHash: `${tag}-reset-${other.id}`, expiresAt: new Date(now.getTime() + 3600_000) },
      ],
    });
    session(user);
    const { status } = await callJson(revokeSessionsPost);
    expect(status).toBe(200);

    const mine = await prisma.verificationToken.findMany({ where: { userId: user.id } });
    expect(mine.length).toBe(2);
    expect(mine.every((t) => t.consumedAt !== null)).toBe(true);

    const theirs = await prisma.verificationToken.findMany({ where: { userId: other.id } });
    expect(theirs).toHaveLength(1);
    expect(theirs[0].consumedAt).toBeNull();

    const bumped = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { sessionVersion: true } });
    expect(bumped.sessionVersion).toBe(1);
  });
});

describe("pass 60 — erasure wipes the account's payment-event trail", () => {
  async function seedPaymentEvent(email: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        kind: "pack",
        provider: "mock",
        amountUsd: 4.99,
        credits: 400,
        idempotencyKey: `${tag}-order-${user.id}`,
      },
    });
    await prisma.paymentEvent.create({
      data: {
        provider: "mock",
        eventId: `${tag}-event-${user.id}`,
        orderId: order.id,
        rawJson: JSON.stringify({ type: "paid", amount: 4.99 }),
      },
    });
    return { user, order };
  }

  it("self-service deletion removes events whose order belonged to the account", async () => {
    const victim = await makeUser();
    const { order } = await seedPaymentEvent(victim.email);
    const bystander = await makeUser();
    const other = await seedPaymentEvent(bystander.email);

    session(victim, 0);
    const { status, body } = await callJson(deletePost, { confirm: true, password: "pass60-password" });
    expect(status, JSON.stringify(body)).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: victim.id } })).toBeNull();
    expect(await prisma.order.findUnique({ where: { id: order.id } })).toBeNull();
    expect(await prisma.paymentEvent.findFirst({ where: { orderId: order.id } })).toBeNull();
    // The wipe is scoped by the account's own orders, not global.
    expect(await prisma.paymentEvent.findFirst({ where: { orderId: other.order.id } })).not.toBeNull();
  });

  it("the admin deletion path wipes them too", async () => {
    const admin = await makeUser({ role: "admin" });
    const victim = await makeUser();
    const { order } = await seedPaymentEvent(victim.email);

    session(admin, 0);
    const res = await adminDelete(new Request(`http://localhost/api/admin/users/${victim.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: victim.id }),
    });
    expect(res.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: victim.id } })).toBeNull();
    expect(await prisma.paymentEvent.findFirst({ where: { orderId: order.id } })).toBeNull();
  });
});
