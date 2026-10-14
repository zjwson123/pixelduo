import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { _setMailerForTests, type Mailer } from "../lib/mail";
import { sendExpiryReminders } from "../lib/reminder";

let userId: string;
let userEmail: string;
const sent: Array<{ to: string; subject: string }> = [];

const fakeMailer: Mailer = {
  send: async (to, subject) => {
    sent.push({ to, subject });
  },
};

// sendExpiryReminders sweeps the WHOLE database by default, and two test files
// call it concurrently (pass 30's expiry-mail case is the other) — so this file
// passes its own scope: a global sweep would let the other file's run claim
// these grants and send the mail through ITS mailer, and neither file could
// assert about its own user deterministically (pass 32: the failure was an
// intermittent red suite whose message named nothing).
const sweep = () => sendExpiryReminders({ userId });
const mine = () => sent.filter((m) => m.to === userEmail);

beforeAll(async () => {
  _setMailerForTests(fakeMailer);
  userEmail = `remind-${Date.now()}@test.dev`;
  const user = await prisma.user.create({
    data: { email: userEmail, passwordHash: "x", name: "Remind Test", emailVerified: new Date() },
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
  // Fixtures sit an hour INSIDE their bucket, not on its boundary (pass 37).
  // They used to be "now + 2d" / "now + 7d" on the HOST clock while the sweep
  // judges daysLeft against the DATABASE's now(), and daysLeft is Math.ceil'd:
  // a database clock a few hundred ms behind the host (a legal state —
  // vitest.setup.ts refuses only past 1000ms) promoted "7 days" to 8, and
  // BUCKETS = [1,3,7] has no 8, so the mail was silently skipped and this file
  // failed naming nothing (probed: same grant at +7d+200ms → mailed=0). An hour
  // of margin makes the bucket what the test means, whatever the skew.
  const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000 - 60 * 60 * 1000);

  it("emails once per bucket and skips far-future grants", async () => {
    await addGrant("PURCHASE", 400, inDays(2)); // bucket 3
    await addGrant("SUBSCRIPTION", 200, inDays(30)); // out of horizon

    await sweep();
    expect(mine()).toHaveLength(1);
    expect(mine()[0].subject).toContain("expire in 3 days");
    expect(mine()[0].subject).not.toContain("400"); // body not subject; subject carries bucket only

    // Same run again → no duplicate TO THIS USER, proven by the claim row.
    await sweep();
    expect(mine()).toHaveLength(1);

    const reminders = await prisma.creditReminder.count({ where: { userId } });
    expect(reminders).toBe(1);
  });

  it("sends a 7-day bucket for grants expiring in a week", async () => {
    await addGrant("PURCHASE", 100, inDays(7));
    await sweep();
    expect(mine().at(-1)?.subject).toContain("expire in 7 days");
    const reminders = await prisma.creditReminder.findMany({ where: { userId } });
    expect(reminders.map((r) => r.daysBefore).sort()).toEqual([3, 7]);
  });
});
