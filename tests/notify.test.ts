import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildWebhookBody,
  buildWebhookText,
  notifyFeedback,
  postWebhook,
  webhookAllowed,
  webhookKind,
  webhookUrl,
} from "../lib/notify";

const input = {
  ref: "cmfb1234abcd5678",
  category: "bug",
  message: "the export button does nothing",
  email: "user@example.com",
  userId: "usr_1",
  plan: "pro",
  page: "/studio",
  locale: "zh",
};

afterEach(() => {
  delete process.env.FEEDBACK_WEBHOOK_URL;
  delete process.env.FEEDBACK_WEBHOOK_KIND;
});

// A real HTTP server, because the thing that can break here is the request
// itself (headers, body shape, timeout) — not a mock's call log.
async function sink(): Promise<{ url: string; received: Array<{ body: string; contentType?: string }>; close: () => Promise<void> }> {
  const received: Array<{ body: string; contentType?: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ body, contentType: req.headers["content-type"] });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 0 }));
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

describe("feedback webhook channel", () => {
  it("names the destination field the way each provider expects", () => {
    expect(buildWebhookBody("feishu", "hi")).toEqual({ msg_type: "text", content: { text: "hi" } });
    expect(buildWebhookBody("wecom", "hi")).toEqual({ msgtype: "text", text: { content: "hi" } });
    expect(buildWebhookBody("dingtalk", "hi")).toEqual({ msgtype: "text", text: { content: "hi" } });
    expect(buildWebhookBody("raw", "hi")).toEqual({ text: "hi" });
  });

  it("puts the actionable context in the message", () => {
    const text = buildWebhookText(input);
    expect(text).toContain("the export button does nothing");
    expect(text).toContain("user@example.com");
    expect(text).toContain("user usr_1");
    expect(text).toContain("pro");
    expect(text).toContain("/studio");
    // The short reference an operator can match against the console row.
    expect(text).toContain("#abcd5678");

    // An anonymous report says so rather than implying an account.
    const anon = buildWebhookText({ ...input, userId: null, plan: null });
    expect(anon).toContain("not signed in");
  });

  it("defaults to feishu and only accepts a known kind", () => {
    expect(webhookKind()).toBe("feishu");
    process.env.FEEDBACK_WEBHOOK_KIND = "wecom";
    expect(webhookKind()).toBe("wecom");
    process.env.FEEDBACK_WEBHOOK_KIND = "something-else";
    expect(webhookKind()).toBe("feishu");
  });

  it("requires https, except loopback which the tests and local sink use", () => {
    expect(webhookAllowed("https://open.feishu.cn/open-apis/bot/v2/hook/xxx")).toBe(true);
    expect(webhookAllowed("http://127.0.0.1:2525/hook")).toBe(true);
    expect(webhookAllowed("http://localhost:2525/hook")).toBe(true);
    // Plain http to a real host would put the bot token on the wire.
    expect(webhookAllowed("http://open.feishu.cn/hook")).toBe(false);
    expect(webhookAllowed("file:///etc/passwd")).toBe(false);
    expect(webhookAllowed("not a url")).toBe(false);
  });

  it("is inert until it is configured", async () => {
    const target = await sink();
    try {
      delete process.env.FEEDBACK_WEBHOOK_URL;
      expect(webhookUrl()).toBeNull();
      await notifyFeedback(input);
      // Nothing was sent anywhere — the channel is opt-in.
      expect(target.received).toHaveLength(0);
    } finally {
      await target.close();
    }
  });

  it("posts the message when configured, and survives a dead endpoint", async () => {
    const target = await sink();
    try {
      process.env.FEEDBACK_WEBHOOK_URL = target.url;
      await notifyFeedback(input);
      expect(target.received).toHaveLength(1);
      expect(target.received[0].contentType).toContain("application/json");
      const body = JSON.parse(target.received[0].body) as { msg_type: string; content: { text: string } };
      expect(body.msg_type).toBe("text");
      expect(body.content.text).toContain("the export button does nothing");
      expect(body.content.text).toContain("#abcd5678");

      // A refused request and an unreachable host must not throw: the feedback
      // row is already stored, and the caller is serving a user's request.
      process.env.FEEDBACK_WEBHOOK_URL = "http://127.0.0.1:1/hook";
      await expect(notifyFeedback(input)).resolves.toBeUndefined();
    } finally {
      await target.close();
    }
  });

  it("refuses to post a bot token over plain http", async () => {
    process.env.FEEDBACK_WEBHOOK_URL = "http://open.feishu.cn/open-apis/bot/v2/hook/secret-token";
    // Silently skipped (and captured), because a misconfigured channel must not
    // fail the submission — but it must not leak the token either.
    await expect(notifyFeedback(input)).resolves.toBeUndefined();
  });
});

describe("the webhook pre-flight check", () => {
  it("reports the endpoint's own verdict, including a refusal carried in the body", async () => {
    // A 200 with errcode is how DingTalk and WeCom refuse a message (keyword
    // missing, token wrong); treating HTTP 200 as success would ship a channel
    // that silently drops everything.
    const refusing = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ errcode: 310000, errmsg: "keywords not in content" }));
    });
    await new Promise<void>((resolve) => refusing.listen(0, "127.0.0.1", resolve));
    const { port } = refusing.address() as AddressInfo;
    try {
      process.env.FEEDBACK_WEBHOOK_URL = `http://127.0.0.1:${port}/hook`;
      const refused = await postWebhook("hello");
      expect(refused.ok).toBe(false);
      expect(refused.body).toContain("310000");

      // A real 2xx with a success body is accepted.
      const accepting = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 0, msg: "success" }));
      });
      await new Promise<void>((resolve) => accepting.listen(0, "127.0.0.1", resolve));
      const okPort = (accepting.address() as AddressInfo).port;
      process.env.FEEDBACK_WEBHOOK_URL = `http://127.0.0.1:${okPort}/hook`;
      const accepted = await postWebhook("hello");
      expect(accepted.ok).toBe(true);
      expect(accepted.status).toBe(200);
      await new Promise<void>((resolve) => accepting.close(() => resolve()));
    } finally {
      await new Promise<void>((resolve) => refusing.close(() => resolve()));
    }
  });

  it("reports an unset url and a bad scheme instead of throwing", async () => {
    delete process.env.FEEDBACK_WEBHOOK_URL;
    const unset = await postWebhook("hello");
    expect(unset.ok).toBe(false);
    expect(unset.error).toMatch(/not set/i);

    process.env.FEEDBACK_WEBHOOK_URL = "http://open.feishu.cn/hook";
    const insecure = await postWebhook("hello");
    expect(insecure.ok).toBe(false);
    expect(insecure.error).toMatch(/https/i);
  });
});
