import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { _setMailerForTests, type Mailer } from "../lib/mail";
import { sendExpiryReminders } from "../lib/reminder";

let userId: string;
const sent: Array<{ to: string; subject: string }> = [];

const fakeMailer: Mailer = {
  send: async (to, subject) => {
    sent.push({ to, subject });
  },
};

beforeAll(async () => {
  _setMailerForTests(fakeMailer);
  const user = await prisma.user.create({
    data: { email: `remind-${Date.now()}@test.dev`, passwordHash: "x", name: "Remind Test", emailVerified: new Date() },
  });
  userId = user.id;
});

afterAll(async () => {
  _setMailerForTests(null);
  await prisma.user.deleteMany({ where: { email: { startsWith: "remind-" } } });
  await prisma.$disconnect();
});

async function addGrant(source: string, remaining: number, expiresAt: Date) {
  await prisma.creditGrant.create({
    data: { userId, source, amount: remaining, remaining, expiresAt, refType: "order", refId: `rem-${Date.now()}-${Math.random()}` },
  });
}

describe("credit expiry reminders", () => {
  it("emails once per bucket and skips far-future grants", async () => {
    await addGrant("PURCHASE", 400, new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)); // bucket 3
    await addGrant("SUBSCRIPTION", 200, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)); // out of horizon

    const sent1 = await sendExpiryReminders();
    expect(sent1).toBe(1);
    expect(sent[0].subject).toContain("expire in 3 days");
    expect(sent[0].subject).not.toContain("400"); // body not subject; subject carries bucket only

    // Same run again → no duplicate.
    expect(await sendExpiryReminders()).toBe(0);

    const reminders = await prisma.creditReminder.count({ where: { userId } });
    expect(reminders).toBe(1);
  });

  it("sends a 7-day bucket for grants expiring in a week", async () => {
    await addGrant("PURCHASE", 100, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    expect(await sendExpiryReminders()).toBe(1);
    expect(sent.at(-1)?.subject).toContain("expire in 7 days");
  });
});
