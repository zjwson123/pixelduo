// The delivery check itself, shared by scripts/verify-mail.ts (CLI) and
// scripts/setup-mail.ts (which writes .env and then immediately proves it).
// The readme-shaped reason this is not inline in the CLI: when the CLI is
// imported, process.argv belongs to the importer, so reading the recipient from
// argv silently targeted the wrong address.
import { feedbackRecipient, mailDeliverable, sendFeedbackEmailWithReceipt } from "./mail";

export interface DeliveryCheck {
  ok: boolean;
  /** SMTP_URL in use, or null when mail is not configured at all. */
  transport: string | null;
  recipient: string;
  response?: string;
  messageId?: string;
  error?: string;
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
  try {
    const receipt = await sendFeedbackEmailWithReceipt({
      ref: "verify-mail",
      category: "other",
      message:
        opts?.note ?? "Pre-flight delivery check from scripts/verify-mail.ts — no action needed.",
      email: "verify-mail@pixelduo.ai",
      page: "/scripts/verify-mail",
      locale: "en",
      userAgent: "scripts/verify-mail.ts",
    });
    return {
      ok: !receipt.rejected?.length,
      transport: process.env.SMTP_URL ?? null,
      recipient,
      response: receipt.response,
      messageId: receipt.messageId,
      error: receipt.rejected?.length ? `the server rejected: ${receipt.rejected.join(", ")}` : undefined,
    };
  } catch (e) {
    return {
      ok: false,
      transport: process.env.SMTP_URL ?? null,
      recipient,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
