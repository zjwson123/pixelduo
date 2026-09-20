// Second notification channel, for deployments where mail is not an option.
//
// Why it exists: reaching the operator by email needs a provider account and,
// usually, a verified sending domain — and on a mainland-China host smtp.gmail.com
// is not even reachable. A Feishu/WeCom/DingTalk group bot is a webhook URL and
// nothing else, which is the shortest path from "someone wrote feedback" to "a
// human saw it". It is deliberately off unless FEEDBACK_WEBHOOK_URL is set.
//
// The URL is operator-supplied configuration, the same trust level as SMTP_URL,
// so it is not routed through the SSRF-pinned fetcher (that guard exists for
// provider-supplied URLs). It is still constrained: https only, except for a
// loopback address which the local test sink uses.
import { captureError } from "./observability";

export type WebhookKind = "feishu" | "wecom" | "dingtalk" | "raw";

export interface NotifyInput {
  ref: string;
  category: string;
  message: string;
  email: string;
  userId?: string | null;
  plan?: string | null;
  page?: string | null;
  locale?: string | null;
}

// Webhook bodies are small and each provider names its fields differently.
export function buildWebhookBody(kind: WebhookKind, text: string): Record<string, unknown> {
  switch (kind) {
    case "feishu":
      return { msg_type: "text", content: { text } };
    case "wecom":
    case "dingtalk":
      return { msgtype: "text", text: { content: text } };
    case "raw":
    default:
      return { text };
  }
}

export function buildWebhookText(input: NotifyInput): string {
  const who = input.userId ? `${input.email} (user ${input.userId})` : `${input.email} (not signed in)`;
  const context = [who, input.plan ? `plan ${input.plan}` : null, input.page ? `from ${input.page}` : null, input.locale]
    .filter(Boolean)
    .join(" · ");
  // Webhooks truncate around 4KB; the message is already capped at 2000 chars by
  // the route, so this stays well inside it.
  return `[PixelDuo] 反馈 · ${input.category}\n${context}\n\n${input.message}\n\nref #${input.ref.slice(-8)}`;
}

export function webhookUrl(): string | null {
  const url = process.env.FEEDBACK_WEBHOOK_URL;
  return url && url.trim() ? url.trim() : null;
}

export function webhookKind(): WebhookKind {
  const kind = (process.env.FEEDBACK_WEBHOOK_KIND ?? "feishu").toLowerCase();
  return kind === "wecom" || kind === "dingtalk" || kind === "raw" ? kind : "feishu";
}

// https everywhere except loopback (the test sink listens on 127.0.0.1).
export function webhookAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  } catch {
    return false;
  }
}

export interface WebhookResult {
  ok: boolean;
  status?: number;
  /** A little of the reply body: providers explain refusals there. */
  body?: string;
  error?: string;
}

// One POST, with the outcome REPORTED instead of captured — the app's own
// notification path deliberately swallows failures (a stored message must not
// fail because a webhook is down), but the pre-flight check in
// scripts/verify-webhook.ts exists to show what the endpoint answered.
export async function postWebhook(text: string): Promise<WebhookResult> {
  const url = webhookUrl();
  if (!url) return { ok: false, error: "FEEDBACK_WEBHOOK_URL is not set" };
  if (!webhookAllowed(url)) {
    return { ok: false, error: "FEEDBACK_WEBHOOK_URL must be https (or a loopback address for testing)" };
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildWebhookBody(webhookKind(), text)),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.text().catch(() => "")).slice(0, 200);
    // Feishu answers 200 with `code`, DingTalk/WeCom sometimes answer 200 with
    // an errcode — so the body is part of the verdict, not just the status.
    const refusedInBody = /"errcode"\s*:\s*(?!0)\d+|"code"\s*:\s*(?!0)\d+/.test(body);
    return { ok: res.ok && !refusedInBody, status: res.status, body };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Best-effort, like the mail notification: the message is already stored, and a
// dead webhook must not turn into an error for the person who wrote it.
export async function notifyFeedback(input: NotifyInput): Promise<void> {
  const url = webhookUrl();
  if (!url) return;
  const result = await postWebhook(buildWebhookText(input));
  if (!result.ok) {
    captureError(
      new Error(
        `feedback webhook failed: ${result.error ?? `answered ${result.status ?? "?"}${result.body ? `: ${result.body}` : ""}`}`,
      ),
      { scope: "notify" },
    );
  }
}
