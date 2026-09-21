// Pass-15 hardening of the feedback notification path, one case per finding.
//
// P15-C1/A3: FEEDBACK_TO was documented but reached no container (compose
//   forwards only the variables its anchor names), and the fallback is a
//   personal mailbox — production must refuse rather than deliver a user's
//   message to whoever wrote the code, and must keep the message.
// P15-C2/C3: the pre-flight scripts printed SMTP_URL / FEEDBACK_WEBHOOK_URL
//   verbatim, and both are credentials in their entirety.
// P15-C4/D1: the webhook POST followed redirects, would post to a private
//   address, and read an unbounded reply.
// P15-C6: per-IP and per-account limits said nothing about the total, and every
//   notification is a mail out of the quota verification/reset mail shares.
//
// Same harness as tests/feedback.test.ts (next-auth's session is the only way
// requireUserId/requireAdmin can see a caller, and the App Router handlers are
// driven directly), so these assertions are about the routes the product serves
// rather than about a replica of them.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import Redis from "ioredis";
import { prisma } from "../lib/prisma";
import {
  FEEDBACK_TO_DEFAULT,
  _resetMailAttemptForTests,
  _setMailerForTests,
  feedbackMailRefusal,
  lastMailAttempt,
  sendFeedbackEmail,
  type Mailer,
} from "../lib/mail";
import { maskSecretUrl } from "../lib/mail-check";
import { buildWebhookText, neutraliseMentions, postWebhook } from "../lib/notify";
import { ADMIN_GUARD_LOCK } from "../lib/admin";

const getServerSession = vi.fn();
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: (...args: unknown[]) => getServerSession(...args) };
});

// The SMTP transport is replaced so no case in this file can open a socket to a
// mail provider — the notification path is asserted through the recording
// mailer below.
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: async () => ({ messageId: "mocked" }) }) },
}));

const { POST: submitFeedback } = await import("../app/api/feedback/route");
const { GET: adminList } = await import("../app/api/admin/feedback/route");

const ROUTE = "http://localhost/api/feedback";

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

// Per-run tag: these cases count rows, and the database is shared with the other
// test files (and, in this pass, with other agents).
const RUN = String(Date.now());
let seq = 0;
function address(label: string): string {
  return `p15-${label}-${RUN}@example.com`;
}
// A fresh source IP per request: the limiter buckets by IP for 10 minutes.
function ip(): string {
  seq += 1;
  return `10.${Math.floor(Math.random() * 250) + 1}.${(seq % 250) + 1}.7`;
}

function request(body: unknown): Request {
  return new Request(ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip(), "user-agent": "vitest/1.0" },
    body: JSON.stringify(body),
  });
}

async function submit(body: unknown): Promise<{ status: number; data: { id?: string; error?: string } }> {
  const res = await submitFeedback(request(body));
  return { status: res.status, data: (await res.json()) as { id?: string; error?: string } };
}

// The runtime predicate reads process.env, so the production cases have to run
// with the environment actually spelling production. Node types NODE_ENV as a
// read-only literal union; tests/payments.test.ts does the same cast for exactly
// this reason.
async function asProduction<T>(fn: () => Promise<T>): Promise<T> {
  const env = process.env as Record<string, string | undefined>;
  const was = env.NODE_ENV;
  env.NODE_ENV = "production";
  try {
    return await fn();
  } finally {
    if (was === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = was;
  }
}

// The notification ceiling lives in Redis for an hour, so it survives a test
// run: without clearing it the low limit this file sets would count submissions
// left behind by an earlier run (of this file or of tests/feedback.test.ts).
async function clearNotifyCeiling(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) return; // no Redis → the limiter is per process, i.e. already fresh
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await client.connect();
    await client.del("rl:feedback:notify-global");
  } catch {
    // Redis down: the limiter falls back to its in-memory bucket, which is fresh.
  } finally {
    client.disconnect();
  }
}

// A real HTTP server, because what can break in the webhook path is the request
// itself (redirect handling, timeouts, how much of the reply is read).
interface Sink {
  url: string;
  received: Array<{ body: string; path: string }>;
  close: () => Promise<void>;
}

async function sink(handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Sink> {
  const received: Array<{ body: string; path: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ body, path: req.url ?? "" });
      if (handler) handler(req, res);
      else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 0 }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

beforeAll(() => {
  _setMailerForTests(recordingMailer);
});

afterEach(() => {
  sent.length = 0;
  getServerSession.mockReset();
  delete process.env.FEEDBACK_WEBHOOK_URL;
  delete process.env.FEEDBACK_NOTIFY_LIMIT;
  delete process.env.FEEDBACK_TO;
  delete process.env.SMTP_URL;
  _resetMailAttemptForTests();
  _setMailerForTests(recordingMailer);
});

afterAll(async () => {
  _setMailerForTests(null);
  await prisma.feedback.deleteMany({ where: { email: { startsWith: `p15-` } } });
  await prisma.feedback.deleteMany({ where: { email: { contains: `p15-paging-${RUN}` } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: `p15-` } } });
  await prisma.$disconnect();
});

describe("feedback notifications never reach the personal fallback (P15-C1/A3)", () => {
  it("refuses in a production runtime only while FEEDBACK_TO is unset", () => {
    const envOf = (env: Record<string, string>) => env as unknown as NodeJS.ProcessEnv;
    expect(feedbackMailRefusal(envOf({ NODE_ENV: "production" }))).toMatch(/FEEDBACK_TO/);
    // Every other spelling of "this is a deployment" is a deployment too — the
    // shared predicate, not an exact-string test (lib/runtime-env.ts).
    expect(feedbackMailRefusal(envOf({ NODE_ENV: "staging" }))).toMatch(/FEEDBACK_TO/);
    expect(feedbackMailRefusal(envOf({ NODE_ENV: "production", FEEDBACK_TO: "support@example.com" }))).toBeNull();
    expect(feedbackMailRefusal(envOf({ NODE_ENV: "production", FEEDBACK_TO: " support@example.com " }))).toBeNull();
    // Development and test keep the old behaviour (the log-only mailer and the
    // e2e/dev flows rely on the default being an address).
    expect(feedbackMailRefusal(envOf({ NODE_ENV: "development" }))).toBeNull();
    expect(feedbackMailRefusal(envOf({ NODE_ENV: "test" }))).toBeNull();
  });

  it("hands the mailer nothing in production, and records the refusal for the console", async () => {
    await asProduction(async () => {
      await sendFeedbackEmail({
        ref: "p15-refused",
        category: "bug",
        message: "this must not be mailed to a stranger",
        email: address("refused"),
      });
    });

    expect(sent).toHaveLength(0);
    const attempt = lastMailAttempt();
    expect(attempt?.ok).toBe(false);
    expect(attempt?.error).toMatch(/FEEDBACK_TO/);
    // The console reads this slot and nothing else, which is why the refusal has
    // to land in it (an unexplained refusal looks like "nobody wrote in").
    expect(attempt?.error).toContain(FEEDBACK_TO_DEFAULT);
  });

  it("keeps the documented default outside production", async () => {
    delete process.env.FEEDBACK_TO;
    await sendFeedbackEmail({
      ref: "p15-default",
      category: "idea",
      message: "dev and test still reach the default address",
      email: address("default"),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(FEEDBACK_TO_DEFAULT);
  });

  it("still stores the report when the notification is refused", async () => {
    getServerSession.mockResolvedValue(null);
    const email = address("stored-when-refused");
    const refusals = await asProduction(async () => {
      const result = await submit({ category: "other", message: "refused notification, kept message", email });
      return result;
    });

    expect(refusals.status, `server said: ${refusals.data.error ?? "no error"}`).toBe(200);
    const row = await prisma.feedback.findUniqueOrThrow({ where: { id: refusals.data.id! } });
    expect(row.email).toBe(email);
    // No mail left the box, but the record an operator works from exists.
    expect(sent).toHaveLength(0);
    expect(lastMailAttempt()?.ok).toBe(false);
  });
});

describe("the pre-flight scripts print no live credential (P15-C2/C3)", () => {
  it("masks the userinfo of an SMTP URL and the token of a bot URL", () => {
    const smtp = maskSecretUrl("smtps://user%40qq.com:authcode16chars@smtp.qq.com:465");
    expect(smtp).toContain("smtps://");
    expect(smtp).toContain("smtp.qq.com:465");
    expect(smtp).toContain("chars");
    expect(smtp).not.toContain("authcode16chars");
    expect(smtp).not.toContain("user@qq.com");

    // Feishu: the token is the last path segment.
    const feishu = maskSecretUrl("https://open.feishu.cn/open-apis/bot/v2/hook/0f1e2d3c-4a5b-6c7d-8e9f-001122334455");
    expect(feishu).toBe("https://open.feishu.cn/open-apis/bot/v2/hook/…(36 chars)");

    // DingTalk and WeCom put it in a query value; the path stays readable so the
    // operator can still see which endpoint they configured.
    const dingtalk = maskSecretUrl("https://oapi.dingtalk.com/robot/send?access_token=abcdef1234567890");
    expect(dingtalk).toBe("https://oapi.dingtalk.com/robot/send?access_token=…(16 chars)");
    const wecom = maskSecretUrl("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=11111111-2222-3333");
    expect(wecom).toBe("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…(18 chars)");

    // A malformed value may hold the credential anywhere in it, so nothing is
    // echoed back — the shape a paste with the surrounding quotes produces —
    // and an unset one is not an error.
    expect(maskSecretUrl('"smtps://user:pw@smtp.qq.com:465"')).toBe("(unparseable URL)");
    expect(maskSecretUrl(null)).toBe("(unset)");
    expect(maskSecretUrl(undefined)).toBe("(unset)");
  });

  it("prints the masked form rather than the environment variable", () => {
    // Source-level on purpose: the alternative is executing these CLIs, which
    // sends a real mail. A line that reports one of these variables without the
    // shared masker is the regression this pins.
    const printedRaw = (source: string) =>
      source
        .split("\n")
        .filter(
          (line) =>
            /console\.(log|error)\(/.test(line) &&
            /process\.env\.SMTP_URL|process\.env\.FEEDBACK_WEBHOOK_URL|webhookUrl\(\)/.test(line) &&
            !/maskSecretUrl/.test(line),
        );
    for (const name of ["verify-mail.ts", "verify-webhook.ts", "setup-mail.ts"]) {
      const file = path.join(process.cwd(), "scripts", name);
      expect(printedRaw(fs.readFileSync(file, "utf8")), `${name} prints a raw credential`).toEqual([]);
    }
  });
});

describe("the webhook POST cannot be aimed at an arbitrary target (P15-C4/D1)", () => {
  it("refuses a redirect instead of following it", async () => {
    const followed = await sink();
    const redirecting = await sink((_req, res) => {
      res.writeHead(307, { location: followed.url });
      res.end();
    });
    try {
      process.env.FEEDBACK_WEBHOOK_URL = redirecting.url;
      const result = await postWebhook("hello");
      expect(result.ok).toBe(false);
      expect(result.status).toBe(307);
      expect(result.error).toMatch(/redirect/i);
      // The point of the pin, not just the verdict: the follow-up request was
      // never issued — a 307 to http://169.254.169.254/… must not be an SSRF
      // primitive that an endpoint's own answer can trigger.
      expect(followed.received).toHaveLength(0);
    } finally {
      await redirecting.close();
      await followed.close();
    }
  });

  it("refuses private, link-local and metadata addresses", async () => {
    for (const url of [
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.5/hook",
      "https://192.168.1.10:8443/hook",
      "https://[::1]/hook",
      "http://localhost:2525/hook", // plain http to loopback is fine, https-only rule aside
    ]) {
      process.env.FEEDBACK_WEBHOOK_URL = url;
      const result = await postWebhook("hello");
      // localhost over http passes the scheme half but is refused in production
      // (test env here), so only the private-address ones must fail everywhere.
      if (url !== "http://localhost:2525/hook") {
        expect(result.ok, `${url} was accepted`).toBe(false);
        expect(result.error, url).toMatch(/private|link-local|https/i);
      }
    }
  });

  it("refuses the loopback test sink once the runtime is production", async () => {
    const target = await sink();
    try {
      process.env.FEEDBACK_WEBHOOK_URL = target.url;
      // Development/test keep the exception the local sink and this file need.
      const allowed = await postWebhook("hello");
      expect(allowed.ok).toBe(true);
      expect(target.received).toHaveLength(1);

      const denied = await asProduction(() => postWebhook("hello"));
      expect(denied.ok).toBe(false);
      expect(denied.error).toMatch(/loopback/i);
      // Refused before the request was built, so the sink saw nothing new.
      expect(target.received).toHaveLength(1);
    } finally {
      await target.close();
    }
  });

  it("rejects a reply over the read cap instead of buffering it", async () => {
    const target = await sink((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // Deliberately chunked and far over the 8 KB cap: the old res.text()
      // buffered the whole thing before slicing it to 200 chars.
      for (let i = 0; i < 64; i++) res.write("x".repeat(1024));
      res.end();
    });
    try {
      process.env.FEEDBACK_WEBHOOK_URL = target.url;
      const result = await postWebhook("hello");
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/bytes/i);
    } finally {
      await target.close();
    }
  });
});

describe("user text cannot plant provider markup (P15-C4)", () => {
  it("neutralises a Feishu mention tag wherever it appears in the notification", () => {
    const planted = '<at user_id="all">所有人</at> please look at this';
    const text = buildWebhookText({
      ref: "cmfb1234abcd5678",
      category: "bug",
      message: planted,
      email: "user@example.com",
      userId: null,
      plan: null,
      page: '<at user_id="all"></at>',
      locale: "en",
    });
    // The words survive (an operator should see that someone tried), the
    // directive does not: `<at …>` is how a Feishu text message mentions.
    expect(text).toContain("所有人");
    expect(text).toContain("please look at this");
    expect(text).not.toMatch(/<\s*\/?\s*at\b/i);
    expect(text).toContain('[at user_id="all"]');
    expect(text).toContain("[/at]");

    // A word that merely starts with "at" is not a tag and must be left alone.
    expect(neutraliseMentions("the atom is <atom>")).toBe("the atom is <atom>");
    expect(neutraliseMentions('<AT USER_ID="all">')).toBe('[AT USER_ID="all"]');
  });
});

describe("outbound feedback notifications have a global ceiling (P15-C6)", () => {
  it("suppresses notifications past the ceiling but still stores and returns the report", async () => {
    getServerSession.mockResolvedValue(null);
    await clearNotifyCeiling();
    process.env.FEEDBACK_NOTIFY_LIMIT = "1";

    const first = await submit({ category: "idea", message: `ceiling case one ${RUN}`, email: address("ceiling-1") });
    expect(first.status, `server said: ${first.data.error ?? "no error"}`).toBe(200);
    expect(sent).toHaveLength(1);

    const second = await submit({ category: "idea", message: `ceiling case two ${RUN}`, email: address("ceiling-2") });
    // The message is received either way — a cap must never cost a user their
    // report, so the sender still gets a 200 and an id to quote.
    expect(second.status, `server said: ${second.data.error ?? "no error"}`).toBe(200);
    expect(second.data.id).toBeTruthy();
    expect(sent).toHaveLength(1);
    const row = await prisma.feedback.findUniqueOrThrow({ where: { id: second.data.id! } });
    expect(row.message).toContain("ceiling case two");
  });

  it("collapses a byte-identical resubmission so a retry does not multiply sends", async () => {
    getServerSession.mockResolvedValue(null);
    await clearNotifyCeiling();
    process.env.FEEDBACK_NOTIFY_LIMIT = "100";

    const body = { category: "billing", message: `a retry that must not send twice ${RUN}`, email: address("retry") };
    const first = await submit(body);
    const retry = await submit(body); // a different source IP, as a retry would be
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(sent).toHaveLength(1);

    // Distinct content is unaffected.
    const other = await submit({ ...body, message: `a genuinely new report ${RUN}` });
    expect(other.status).toBe(200);
    expect(sent).toHaveLength(2);
  });
});

describe("the admin inbox stays reachable past the first page (P15-C5)", () => {
  it("reports the total and serves the older pages", async () => {
    const admin = await prisma.user.create({
      data: { email: `p15-admin-${RUN}@test.dev`, passwordHash: "x", name: "p15-admin", role: "admin" },
    });
    const tag = `p15-paging-${RUN}`;
    // PAGE_SIZE is 50, so 55 rows guarantee that the oldest five are off page 1.
    const rows = Array.from({ length: 55 }, (_, i) => ({
      email: `${tag}-${String(i).padStart(2, "0")}@example.com`,
      category: "idea",
      message: `paging row ${i}`,
      createdAt: new Date(Date.now() - i * 1000),
    }));
    await prisma.feedback.createMany({ data: rows });
    const oldest = await prisma.feedback.findFirstOrThrow({
      where: { email: `${tag}-54@example.com` },
      select: { id: true },
    });

    getServerSession.mockResolvedValue({ user: { id: admin.id, sv: 0, totpPending: false } });
    interface Page {
      feedback: Array<{ id: string }>;
      total: number;
      page: number;
      pageSize: number;
    }
    const readPage = async (page: number): Promise<Page> => {
      const res = await adminList(new Request(`http://localhost/api/admin/feedback?status=all&page=${page}`));
      expect(res.status).toBe(200);
      return (await res.json()) as Page;
    };

    const first = await readPage(1);
    expect(first.pageSize).toBe(50);
    expect(first.feedback).toHaveLength(50);
    // The console used to show exactly these 50 and drop `total`, which is how an
    // inbox of 60 looked complete.
    expect(first.total).toBeGreaterThanOrEqual(55);
    expect(first.feedback.map((f) => f.id)).not.toContain(oldest.id);

    // Reachable: the 55th row arrives through the page parameter rather than
    // being pushed out of view by whatever was submitted after it.
    const seen = new Set(first.feedback.map((f) => f.id));
    let found = false;
    for (let page = 2; page <= 4 && !found; page++) {
      const next = await readPage(page);
      expect(next.page).toBe(page);
      for (const row of next.feedback) {
        expect(seen.has(row.id), "pages overlap").toBe(false);
        seen.add(row.id);
      }
      found = next.feedback.some((f) => f.id === oldest.id);
    }
    expect(found, "the oldest report was never reachable by paging").toBe(true);

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_GUARD_LOCK})`;
      await tx.user.delete({ where: { id: admin.id } });
    });
  });
});
