// Second notification channel, for deployments where mail is not an option.
//
// Why it exists: reaching the operator by email needs a provider account and,
// usually, a verified sending domain — and on a mainland-China host smtp.gmail.com
// is not even reachable. A Feishu/WeCom/DingTalk group bot is a webhook URL and
// nothing else, which is the shortest path from "someone wrote feedback" to "a
// human saw it". It is deliberately off unless FEEDBACK_WEBHOOK_URL is set.
//
// The URL is operator-supplied configuration, the same trust level as SMTP_URL,
// so it is not routed through the SSRF-pinned fetchPublicBuffer (that guard
// exists for provider-supplied URLs, and this one must also accept a loopback
// sink in development). "Trusted operator" is not a reason to let the endpoint
// pick the destination, though: the POST itself is pinned (https except for the
// loopback test sink), refuses redirects, refuses to resolve to a
// private/link-local address — and runs on the same connect-time-pinned agent
// as every other outbound call, so a name that resolves public for the check
// and internal for the connect does not get dialled — and bounds its reply (see
// postWebhook).
import { fetch as pinnedFetch } from "undici";
import { captureError } from "./observability";
import { isProductionRuntime } from "./runtime-env";
// The bounded reader the rest of the codebase uses for an outbound response
// body (lib/store.ts). Reused rather than re-implemented: the two things that
// must agree here — "how much may we read" and "is the target acceptable" —
// already have one answer each in that module.
import { hostIsPublic, isPublicPort, readBodyCapped, ssrfPinnedAgent } from "./store";
import { quoteUntrusted, singleLine } from "./untrusted-text";

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

// Feishu's text message type interprets `<at user_id="…">…</at>` (and the
// `<at email="…">` form) as a real mention directive. The feedback body is
// written by anyone, signed out and unauthenticated, so a submitter who types
// that tag makes every LATER notification in the group @-mention the whole ops
// group — silently, in a message the operator reads as ordinary text. Renaming
// the tag rather than stripping it keeps the text readable AND shows the
// operator that someone planted one. Only this form needs handling: DingTalk
// and WeCom take their mentions from dedicated payload fields (atMobiles /
// atUserIds) that this module never sends, and their text bodies have no
// mention syntax at all.
const MENTION_TAG = /<\s*(\/?\s*at)\b([^>]*)>/gi;

export function neutraliseMentions(text: string): string {
  // The tag's own spelling is kept, only its delimiters change: an operator
  // reading the notification sees exactly what was typed.
  return text.replace(MENTION_TAG, (_match, name: string, attrs: string) => `[${name}${attrs}]`);
}

export function buildWebhookText(input: NotifyInput): string {
  const who = input.userId ? `${input.email} (user ${input.userId})` : `${input.email} (not signed in)`;
  // `page` is caller-controlled and lands unquoted on the context LINE, which
  // is joined with " · " and read as one line: a CR, NEL or U+2028 would start
  // a new one inside the machine-generated block the operator triages from
  // (pass 33, the same class the mail builder flattens). Quoted as well
  // (pass 41): the separator itself is " · ", so a page value containing it —
  // `/studio · plan enterprise · from ceo@corp (user X)` — appended fake fields
  // to the line without any control character. JSON quoting marks the whole
  // value as one string, and escapes the quote character too.
  const page = input.page ? JSON.stringify(singleLine(input.page)) : null;
  const context = [who, input.plan ? `plan ${input.plan}` : null, page ? `from ${page}` : null, input.locale]
    .filter(Boolean)
    .join(" · ");
  // Webhooks truncate around 4KB; the message is already capped at 2000 chars by
  // the route, so this stays well inside it.
  //
  // The message is quoted line by line, for the same reason the operator mail
  // quotes it (lib/mail.ts): it is arbitrary multi-line text sitting next to
  // machine-generated lines (`[PixelDuo] 反馈 · …`, the context line, `ref #…`),
  // so an unquoted message could plant a second, forged set of them — including
  // a `ref #` pointing at somebody else's report — above the real one.
  const text = `[PixelDuo] 反馈 · ${input.category}\n${context}\n\n${quoteUntrusted(input.message)}\n\nref #${input.ref.slice(-8)}`;
  // Applied to the assembled text, not to input.message alone: `email` and
  // `page` reach the same payload and are just as caller-controlled.
  return neutraliseMentions(text);
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
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    // Loopback is the documented test exception and it lives on an ephemeral
    // port, so the allowlist below cannot apply to it — webhookTargetAllowed
    // refuses loopback outright in production, which is where that matters.
    if (loopback) return parsed.protocol === "https:" || parsed.protocol === "http:";
    // Every other guarded outbound path applies the port allowlist (see
    // isPublicPort); this was the one caller that skipped it, so
    // FEEDBACK_WEBHOOK_URL=https://<public-ip>:<any-port> was dialled on
    // whatever port it named. Operator-supplied, so this is hardening rather
    // than a hole — but drift between the two paths is exactly how the last few
    // passes found their bugs.
    if (!isPublicPort(parsed.port)) return false;
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Where a notification may actually be sent, decided at POST time.
//
// `webhookAllowed` above is only the scheme half, and it has to stay
// synchronous (a caller wants a verdict without awaiting DNS). The address half
// cannot be: a hostname is not a destination until it resolves, and a name that
// resolves public at check time and internal at connect time is the classic
// rebinding shape. Both halves are applied to the operator's URL before the
// request is built, and the same policy is what makes a redirect unsafe to
// follow — a 307 to http://169.254.169.254/… would otherwise let the endpoint
// choose the target inside the compose network.
//
// Loopback is the documented test exception (tests/notify.test.ts and the local
// sink listen on 127.0.0.1), and it is kept for development/test runtimes only:
// a production deployment has no business posting its feedback to its own
// loopback, and that is exactly the address a rebinding attack wants.
async function webhookTargetAllowed(url: string): Promise<string | null> {
  if (!webhookAllowed(url)) {
    return "FEEDBACK_WEBHOOK_URL must be https (or a loopback address for testing)";
  }
  const hostname = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "127.0.0.1" || hostname === "localhost") {
    return isProductionRuntime() ? "a loopback webhook is a test-only address and is refused in production" : null;
  }
  if (!(await hostIsPublic(hostname))) {
    return "FEEDBACK_WEBHOOK_URL resolves to a private, link-local or reserved address — refusing to post (an endpoint that means to be public must resolve publicly)";
  }
  return null;
}

export interface WebhookResult {
  ok: boolean;
  status?: number;
  /** A little of the reply body: providers explain refusals there. */
  body?: string;
  error?: string;
}

// How much of the endpoint's reply we are willing to read. A bot answers with a
// short JSON ack; the snippet that gets reported is 200 chars of it. Anything
// past this is not a refusal reason, it is a body someone else decides the size
// of — res.text() buffered all of it before the slice, so a hostile or merely
// broken endpoint (a URL pointing at a web page, say) could drive the heap.
const WEBHOOK_REPLY_MAX_BYTES = 8 * 1024;

// The connect-time pin applies to every destination EXCEPT the documented
// loopback test sink. This is not a weakening: the pinned agent refuses private
// addresses by design, so using it on 127.0.0.1 would break the one case
// webhookTargetAllowed deliberately allows (tests/notify.test.ts,
// scripts/dev-smtp-sink.mjs' sibling sink, scripts/verify-webhook.ts), and that
// exemption exists only outside production (`isProductionRuntime` refuses a
// loopback webhook outright). Exported so a test can assert which path a given
// URL takes instead of trusting this comment.
export function webhookDispatcher(url: string): typeof ssrfPinnedAgent | undefined {
  const hostname = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return hostname === "127.0.0.1" || hostname === "localhost" ? undefined : ssrfPinnedAgent;
}

// One POST, with the outcome REPORTED instead of captured — the app's own
// notification path deliberately swallows failures (a stored message must not
// fail because a webhook is down), but the pre-flight check in
// scripts/verify-webhook.ts exists to show what the endpoint answered.
export async function postWebhook(text: string): Promise<WebhookResult> {
  const url = webhookUrl();
  if (!url) return { ok: false, error: "FEEDBACK_WEBHOOK_URL is not set" };
  const denied = await webhookTargetAllowed(url);
  if (denied) return { ok: false, error: denied };
  try {
    // undici's fetch, not the global one: only this signature accepts a
    // dispatcher, which is the whole point (lib/store.ts and lib/safety.ts use
    // it for the same reason).
    const res = (await pinnedFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildWebhookBody(webhookKind(), text)),
      signal: AbortSignal.timeout(5000),
      // Pinned at CONNECT time, not just checked before the request: the guard
      // above resolves the operator's host once, and fetch would otherwise
      // resolve it a second time on its own — the rebinding shape this file's
      // header describes and lib/store.ts's guarded fetch closes. The header
      // claimed the POST was pinned; it was checked and then resolved again.
      dispatcher: webhookDispatcher(url),
      // No redirects — every other outbound call in this codebase pins this
      // (lib/providers/index.ts, lib/safety.ts, lib/router.ts, lib/assistant.ts)
      // and for the same reason: the follow-up request is issued to an address
      // the operator never configured, from inside the deployment's network,
      // with this POST's body. Nothing here needs the header a redirect would
      // drop, so following one is pure SSRF surface. A 3xx simply fails.
      redirect: "manual",
    })) as unknown as Response;
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        status: res.status,
        error: `the endpoint redirected (${res.status}) instead of accepting the message — point FEEDBACK_WEBHOOK_URL at the final address`,
      };
    }
    let reply: string;
    try {
      // Bounded like every other outbound read; an over-cap reply is a failure,
      // not a truncated success, because the over-cap case is also how a
      // misconfigured URL (an HTML page, an object store) answers.
      reply = (await readBodyCapped(res, WEBHOOK_REPLY_MAX_BYTES)).toString("utf8");
    } catch (e) {
      // Only readBodyCapped's over-cap sentinel is a verdict about the endpoint;
      // anything else (the timeout aborting the body, a reset connection) is a
      // transport error and is reported by the catch below, with its own words.
      if (!(e instanceof Error) || e.message !== "download-too-large") throw e;
      return {
        ok: false,
        status: res.status,
        error: `the endpoint answered with more than ${WEBHOOK_REPLY_MAX_BYTES} bytes — that is not a bot acknowledgement`,
      };
    }
    const body = reply.slice(0, 200);
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
