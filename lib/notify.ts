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

// Best-effort, like the mail notification: the message is already stored, and a
// dead webhook must not turn into an error for the person who wrote it.
export async function notifyFeedback(input: NotifyInput): Promise<void> {
  const url = webhookUrl();
  if (!url) return;
  if (!webhookAllowed(url)) {
    captureError(new Error("FEEDBACK_WEBHOOK_URL must be https (or a loopback address for testing)"), {
      scope: "notify",
    });
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildWebhookBody(webhookKind(), buildWebhookText(input))),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      // Read a little of the reply: webhook providers explain refusals there
      // (a DingTalk bot without the required keyword answers 200 with errcode).
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      captureError(new Error(`feedback webhook answered ${res.status}${detail ? `: ${detail}` : ""}`), {
        scope: "notify",
      });
    }
  } catch (e) {
    captureError(e, { scope: "notify" });
  }
}
