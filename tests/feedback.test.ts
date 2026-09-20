import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../lib/prisma";
import { _setMailerForTests, FEEDBACK_TO_DEFAULT, type Mailer } from "../lib/mail";
import { FEEDBACK_MESSAGE_MAX, FEEDBACK_MESSAGE_MIN } from "../lib/feedback-meta";
import { ADMIN_GUARD_LOCK } from "../lib/admin";

const getServerSession = vi.fn();
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: (...args: unknown[]) => getServerSession(...args) };
});

const { POST: submitFeedback, GET: listMine } = await import("../app/api/feedback/route");
const { GET: adminList } = await import("../app/api/admin/feedback/route");
const { PATCH: adminPatch } = await import("../app/api/admin/feedback/[id]/route");

interface Sent {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}
const sent: Sent[] = [];
const recordingMailer: Mailer = {
  async send(to, subject, text, _html, replyTo) {
    sent.push({ to, subject, text, replyTo });
  },
};

let seq = 0;
// Per-run tag: these assertions count rows, and a fixed address would count the
// rows a previous run of this file left in the shared test database.
const RUN = String(Date.now());
function anon(label: string): string {
  return `fb-${label}-${RUN}@example.com`;
}
// Unique address per request: the limiter buckets by client IP for 10 minutes,
// so a fixed value would make a second run of this file 429 (pass-13 lesson).
function ip(): string {
  seq += 1;
  return `10.${Math.floor(Math.random() * 250) + 1}.${(seq % 250) + 1}.9`;
}

async function makeUser(label: string, extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: {
      email: `fb-${label}-${Date.now()}-${seq++}@test.dev`,
      passwordHash: "x",
      name: label,
      ...extra,
    },
  });
}

function request(body: unknown, extraHeaders: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip(), "user-agent": "vitest/1.0", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

// Submits and carries the server's own error into the assertion message, so a
// failure reports WHY instead of only "expected 200".
async function submit(
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; data: { id?: string; error?: string } }> {
  const res = await submitFeedback(request(body, extraHeaders));
  return { status: res.status, data: (await res.json()) as { id?: string; error?: string } };
}

function expectAccepted(result: { status: number; data: { error?: string } }): void {
  expect(result.status, `server said: ${result.data.error ?? "no error field"}`).toBe(200);
}

beforeAll(() => {
  _setMailerForTests(recordingMailer);
});

afterEach(() => {
  sent.length = 0;
  getServerSession.mockReset();
  delete process.env.FEEDBACK_TO;
});

afterAll(async () => {
  _setMailerForTests(null);
  await prisma.user.deleteMany({ where: { email: { startsWith: "fb-" } } });
  await prisma.feedback.deleteMany({ where: { email: { contains: "@test.dev" } } });
  await prisma.$disconnect();
});

describe("feedback submission", () => {
  it("stores a signed-in message with the account's identity and mails the operator", async () => {
    const user = await makeUser("signed-in", { plan: "pro", credits: 10 });
    getServerSession.mockResolvedValue({ user: { id: user.id, sv: 0, totpPending: false } });

    const res = await submitFeedback(
      request({ category: "bug", message: "the export button does nothing on Firefox", page: "/studio", locale: "en" }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; id: string };
    expect(data.ok).toBe(true);

    const row = await prisma.feedback.findUniqueOrThrow({ where: { id: data.id } });
    expect(row.userId).toBe(user.id);
    expect(row.email).toBe(user.email);
    expect(row.plan).toBe("pro");
    expect(row.category).toBe("bug");
    expect(row.page).toBe("/studio");
    expect(row.locale).toBe("en");
    expect(row.status).toBe("new");

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(FEEDBACK_TO_DEFAULT);
    expect(sent[0].replyTo).toBe(user.email);
    expect(sent[0].text).toContain("the export button does nothing on Firefox");
    expect(sent[0].text).toContain(`user ${user.id}`);
    // The reference in the mail is the row an operator will look up.
    expect(sent[0].text).toContain(row.id);
  });

  it("ignores a client-supplied email when the caller is signed in", async () => {
    const user = await makeUser("spoof", { credits: 10 });
    getServerSession.mockResolvedValue({ user: { id: user.id, sv: 0, totpPending: false } });
    const res = await submitFeedback(
      request({ category: "other", message: "please ignore the address in this body", email: "someone-else@example.com" }),
    );
    const { id } = (await res.json()) as { id: string };
    const row = await prisma.feedback.findUniqueOrThrow({ where: { id } });
    // The reply address must be a mailbox the account proved it owns.
    expect(row.email).toBe(user.email);
    expect(sent[0].replyTo).toBe(user.email);
  });

  it("accepts an anonymous report when it carries an email, and refuses one without", async () => {
    getServerSession.mockResolvedValue(null);
    const noEmail = await submit({ category: "billing", message: `I was charged twice for a pack ` });
    expect(noEmail.status).toBe(400);
    expect(noEmail.data.error).toMatch(/^invalid-input/);
    expect(await prisma.feedback.count({ where: { message: `I was charged twice for a pack ` } })).toBe(0);

    const withEmail = await submit({ category: "billing", message: `I was charged twice for a pack `, email: anon("anon") });
    expectAccepted(withEmail);
    const id = withEmail.data.id!;
    const row = await prisma.feedback.findUniqueOrThrow({ where: { id } });
    expect(row.userId).toBeNull();
    expect(row.email).toBe(anon("anon"));
    expect(row.plan).toBeNull();
    expect(sent[0].to).toBe(FEEDBACK_TO_DEFAULT);
    expect(sent[0].replyTo).toBe(anon("anon"));
  });

  it("honours FEEDBACK_TO when the deployment sets it", async () => {
    process.env.FEEDBACK_TO = "tickets@example.com";
    getServerSession.mockResolvedValue(null);
    expectAccepted(await submit({ category: "idea", message: "a bulk download button would help", email: anon("to") }));
    expect(sent[0].to).toBe("tickets@example.com");
  });

  it("validates the category and the message length before storing anything", async () => {
    getServerSession.mockResolvedValue(null);
    // A dedicated address: earlier cases in this file submit successfully, and a
    // shared one would make "nothing was stored" pass or fail by ordering.
    const address = anon("validator");
    const badCategory = await submitFeedback(
      request({ category: "complaint", message: "a long enough message body", email: address }),
    );
    expect(badCategory.status).toBe(400);

    const tooShort = await submitFeedback(
      request({ category: "idea", message: "x".repeat(FEEDBACK_MESSAGE_MIN - 1), email: address }),
    );
    expect(tooShort.status).toBe(400);
    expect(((await tooShort.json()) as { error: string }).error).toMatch(/^invalid-input/);

    const tooLong = await submitFeedback(
      request({ category: "idea", message: "y".repeat(FEEDBACK_MESSAGE_MAX + 1), email: address }),
    );
    expect(tooLong.status).toBe(400);

    expect(await prisma.feedback.count({ where: { email: address } })).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("still records the message when the mailer fails", async () => {
    _setMailerForTests({
      async send() {
        throw new Error("smtp down");
      },
    });
    getServerSession.mockResolvedValue(null);
    expectAccepted(await submit({ category: "other", message: "the mailer is down but keep this", email: anon("resilient") }));
    expect(await prisma.feedback.count({ where: { email: anon("resilient") } })).toBe(1);
    _setMailerForTests(recordingMailer);
  });

  it("rate limits per IP and per account", async () => {
    getServerSession.mockResolvedValue(null);
    const sameIp = ip();
    let limited = 0;
    for (let i = 0; i < 7; i++) {
      const res = await submitFeedback(
        request({ category: "idea", message: `flood message number ${i}`, email: anon("flood") }, { "x-forwarded-for": sameIp }),
      );
      if (res.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);

    // A signed-in account is capped on its own axis too: one account, many IPs.
    const user = await makeUser("per-account", { credits: 10 });
    getServerSession.mockResolvedValue({ user: { id: user.id, sv: 0, totpPending: false } });
    let userLimited = 0;
    for (let i = 0; i < 7; i++) {
      const res = await submitFeedback(request({ category: "idea", message: `account flood number ${i}` }));
      if (res.status === 429) userLimited += 1;
    }
    expect(userLimited).toBeGreaterThan(0);
  });
});

describe("the sender's own message history", () => {
  it("lists only the caller's messages, newest first, and refuses anonymous callers", async () => {
    const user = await makeUser("history", { credits: 10 });
    const other = await makeUser("history-other", { credits: 10 });
    await prisma.feedback.create({
      data: { userId: user.id, email: user.email, category: "idea", message: "my older message", createdAt: new Date(Date.now() - 60_000) },
    });
    await prisma.feedback.create({
      data: { userId: user.id, email: user.email, category: "bug", message: "my newer message" },
    });
    await prisma.feedback.create({
      data: { userId: other.id, email: other.email, category: "other", message: "someone else's private message" },
    });

    getServerSession.mockResolvedValue(null);
    expect((await listMine()).status).toBe(401);

    getServerSession.mockResolvedValue({ user: { id: user.id, sv: 0, totpPending: false } });
    const res = await listMine();
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { feedback: Array<{ message: string }> };
    const messages = payload.feedback.map((f) => f.message);
    expect(messages[0]).toBe("my newer message");
    expect(messages).toContain("my older message");
    // Scoped by owner: another account's message must never appear.
    expect(messages).not.toContain("someone else's private message");
  });
});

describe("admin feedback inbox", () => {  it("is admin-only, lists newest first, counts unhandled, and marks handled", async () => {
    const admin = await makeUser("admin", { role: "admin", credits: 10 });
    const reporter = await makeUser("reporter", { credits: 10 });
    // Relative to the rows other cases left behind: an absolute count here would
    // depend on what ran before it in this file.
    const before = await prisma.feedback.count({ where: { status: "new" } });
    const older = await prisma.feedback.create({
      data: { userId: reporter.id, email: reporter.email, category: "idea", message: "first message here", createdAt: new Date(Date.now() - 60_000) },
    });
    const newer = await prisma.feedback.create({
      data: { userId: reporter.id, email: reporter.email, category: "bug", message: "second message here" },
    });

    // Non-admin: the console must not be readable by a normal account.
    getServerSession.mockResolvedValue({ user: { id: reporter.id, sv: 0, totpPending: false } });
    expect((await adminList(new Request("http://localhost/api/admin/feedback"))).status).toBe(403);

    getServerSession.mockResolvedValue({ user: { id: admin.id, sv: 0, totpPending: false } });
    const list = await adminList(new Request("http://localhost/api/admin/feedback?status=all"));
    expect(list.status).toBe(200);
    const payload = (await list.json()) as { feedback: Array<{ id: string }>; unhandled: number };
    expect(payload.unhandled).toBe(before + 2);
    const ids = payload.feedback.map((f) => f.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    // The unhandled-only view drops nothing that is still open.
    const open = await adminList(new Request("http://localhost/api/admin/feedback"));
    const openIds = ((await open.json()) as { feedback: Array<{ id: string }> }).feedback.map((f) => f.id);
    expect(openIds).toContain(newer.id);

    const patched = await adminPatch(
      new Request(`http://localhost/api/admin/feedback/${newer.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      }),
      { params: Promise.resolve({ id: newer.id }) },
    );
    expect(patched.status).toBe(200);
    const row = await prisma.feedback.findUniqueOrThrow({ where: { id: newer.id } });
    expect(row.status).toBe("done");
    expect(row.handledBy).toBe(admin.id);
    expect(row.handledAt).not.toBeNull();

    const unknown = await adminPatch(
      new Request("http://localhost/api/admin/feedback/does-not-exist", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      }),
      { params: Promise.resolve({ id: "does-not-exist" }) },
    );
    expect(unknown.status).toBe(404);

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_GUARD_LOCK})`;
      await tx.feedback.deleteMany({ where: { id: { in: [older.id, newer.id] } } });
      await tx.user.deleteMany({ where: { id: { in: [admin.id, reporter.id] } } });
    });
  });

  it("erases a signed-in reporter's messages with the account (GDPR)", async () => {
    const user = await makeUser("erased", { credits: 10 });
    await prisma.feedback.create({
      data: { userId: user.id, email: user.email, category: "other", message: "delete me with the account" },
    });
    await prisma.user.delete({ where: { id: user.id } });
    expect(await prisma.feedback.count({ where: { userId: user.id } })).toBe(0);
  });
});
