// The delivery check itself, shared by scripts/verify-mail.ts (CLI) and
// scripts/setup-mail.ts (which writes .env and then immediately proves it).
// The readme-shaped reason this is not inline in the CLI: when the CLI is
// imported, process.argv belongs to the importer, so reading the recipient from
// argv silently targeted the wrong address.
//
// maskSecretUrl() lives here as well: this module is already what both mail
// scripts import, and scripts/verify-webhook.ts prints a group-bot token the
// same way, so "what may a pre-flight print" has exactly one answer.
import {
  feedbackMailRefusal,
  feedbackRecipient,
  mailDeliverable,
  sendFeedbackEmailToWithReceipt,
} from "./mail";

export interface DeliveryCheck {
  ok: boolean;
  /** SMTP_URL in use (credential masked), or null when mail is not configured at all. */
  transport: string | null;
  recipient: string;
  response?: string;
  messageId?: string;
  error?: string;
}

// Every URL this app asks an operator to paste into it IS a credential:
// SMTP_URL carries the SMTP password in its userinfo, and a Feishu/WeCom/
// DingTalk group-bot URL is nothing but a token (Feishu puts it in the last
// path segment; DingTalk's access_token= and WeCom's key= live in the query).
// The docs and the admin console's failure banner tell the operator to run
// these pre-flight scripts and relay what they printed, so echoing the value
// verbatim discloses the outbound-mail credential — or a bot token that can
// post as the bot — into a ticket, a chat or a CI log. scripts/setup-mail.ts
// already masked exactly that for its own one-line summary, so the codebase had
// two answers for the same secret and the verification path gave the wrong one.
//
// Keep what a human needs in order to spot the real first-run mistakes (scheme,
// host, port, which endpoint shape) and replace each secret with a length hint:
// enough to confirm "this is the value I pasted", unusable to authenticate.
// Deliberately no "first N characters" prefix — 2-4 characters of a credential
// is still credential material.

// What a bot token looks like in a path: Feishu's is a 36-character uuid, and
// nothing shorter than this is a credential on any provider this app supports.
// The colon is in the class for Telegram, whose path segment is
// `bot<bot-id>:<secret>` — one segment, two credential halves.
const PATH_TOKEN = /^[A-Za-z0-9._~:-]{16,}$/;

export function maskSecretUrl(url: string | null | undefined): string {
  if (!url) return "(unset)";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // An unparseable value (a stray quote, a pasted line break) may hold the
    // credential anywhere in it, so never echo it back.
    return "(unparseable URL)";
  }
  const secret = (value: string) => `…(${value.length} chars)`;
  // Presets percent-encode the userinfo, so measure the decoded form: the
  // operator counts the characters they pasted.
  const decoded = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const userinfo = parsed.username
    ? `${secret(decoded(parsed.username) + (parsed.password ? `:${decoded(parsed.password)}` : ""))}@`
    : "";
  const segments = parsed.pathname.split("/");
  // EVERY token-shaped segment, not just the last one. Feishu's bot URL ends in
  // a 36-character uuid, but a trailing slash — the standard copy-paste artefact,
  // and invisible when you paste a URL — left that last segment EMPTY, so the
  // real token one segment earlier was echoed in full by
  // scripts/verify-webhook.ts into a terminal, a CI log or a ticket. A token in
  // a non-final position (a Telegram-style /bot<token>/sendMessage) was never
  // considered at all. "…/hook" and "…/send" are not token-shaped, so the
  // endpoint shape an operator uses to spot a misconfiguration survives.
  for (let i = 1; i < segments.length; i++) {
    if (PATH_TOKEN.test(decoded(segments[i]))) segments[i] = secret(decoded(segments[i]));
  }
  const query = [...new Set(parsed.searchParams.keys())]
    .map((key) => `${key}=${secret(decoded(parsed.searchParams.get(key) ?? ""))}`)
    .join("&");
  // The fragment is dropped rather than masked: nothing in these URLs uses one,
  // and it is the one part of a URL that can hold a secret of unknown shape.
  return `${parsed.protocol}//${userinfo}${parsed.host}${segments.join("/")}${query ? `?${query}` : ""}`;
}

// Turn a transport error into the fix. Every one of these has been the actual
// first-run failure for someone: the credential type, the sender domain, the
// port/scheme pair, the provider's sandbox rules.
export function describeMailFailure(message: string): string | null {
  if (/535|535-5\.7\.8|Username and Password not accepted|Invalid login|authentication failed|5\.7\.8/i.test(message)) {
    return "Authentication rejected. Gmail and QQ/163 need an APP PASSWORD / 授权码 (not the account password); Aliyun DirectMail needs the console-set password.";
  }
  if (/not verified|domain is not verified|not authorized to send|553|5\.7\.2|Sender address rejected|not allowed to send/i.test(message)) {
    return "The provider refuses EMAIL_FROM's domain. Verify the sending domain (Resend/SES/SendGrid/Aliyun DirectMail all require it) and add its SPF + DKIM DNS records; until then use the provider's own onboarding address as EMAIL_FROM.";
  }
  if (/PBL|Spamhaus|blacklist|5\.7\.1/i.test(message)) {
    return "The sending IP is blocklisted (SES/Resend exist for exactly this reason). Use a provider's relay, not a bare IP.";
  }
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|getaddrinfo|greeting never received/i.test(message)) {
    return "Could not reach the SMTP host — check the host/port pair, and note that port 465 is TLS-from-the-start (smtps://) while 587 upgrades with STARTTLS (smtp://).";
  }
  if (/self.signed|SSL|TLS|certificate|wrong version number/i.test(message)) {
    return "TLS mismatch — port 465 must be smtps:// and 587 smtp://; the URL scheme decides which handshake is attempted.";
  }
  if (/421|rate limit|too many|Daily message quota|5\.4\.5/i.test(message)) {
    return "The provider accepted the connection but refused this message (quota/rate limit, or a sandbox account restricted to its own address). Check the provider's dashboard.";
  }
  if (/No recipients defined/i.test(message)) {
    return "No recipient was given and FEEDBACK_TO is empty — pass one explicitly.";
  }
  return null;
}

export async function checkDelivery(opts?: { recipient?: string; note?: string }): Promise<DeliveryCheck> {
  const recipient = opts?.recipient || feedbackRecipient();
  if (!mailDeliverable()) {
    return {
      ok: false,
      transport: null,
      recipient,
      error: "SMTP_URL is not set, so mail goes to the server log instead of a mailbox",
    };
  }
  // Asked before the send so a production deployment that never named its own
  // mailbox fails as a configuration refusal instead of a transport error —
  // the send itself refuses too (lib/mail.ts), this is the readable reason.
  const refusal = feedbackMailRefusal();
  if (refusal) {
    return { ok: false, transport: maskSecretUrl(process.env.SMTP_URL), recipient, error: refusal };
  }
  try {
    const receipt = await sendFeedbackEmailToWithReceipt(
      {
        ref: "verify-mail",
        category: "other",
        message:
          opts?.note ?? "Pre-flight delivery check from scripts/verify-mail.ts — no action needed.",
        email: "verify-mail@pixelduo.ai",
        page: "/scripts/verify-mail",
        locale: "en",
        userAgent: "scripts/verify-mail.ts",
      },
      recipient,
    );
    return {
      ok: !receipt.rejected?.length,
      transport: maskSecretUrl(process.env.SMTP_URL),
      recipient,
      response: receipt.response,
      messageId: receipt.messageId,
      error: receipt.rejected?.length ? `the server rejected: ${receipt.rejected.join(", ")}` : undefined,
    };
  } catch (e) {
    return {
      ok: false,
      transport: maskSecretUrl(process.env.SMTP_URL),
      recipient,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
