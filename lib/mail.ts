import nodemailer, { type Transporter } from "nodemailer";
import fs from "fs";
import path from "path";
import { captureError } from "./observability";
import { isProductionRuntime } from "./runtime-env";
import { rateLimit, envLimit } from "./rate-limit";
import {
  verificationHtml,
  resetHtml,
  receiptHtml,
  refundHtml,
  expiryHtml,
} from "./mail-html";

// What the transport reported back. SMTP's own acceptance line ("250 2.0.0 Ok:
// queued as …") is the only proof a mail left us and was taken by the receiving
// server — the app's own mails ignore it (a message that was stored must not
// fail because SMTP did), but the pre-flight check in scripts/verify-mail.ts
// exists to show it.
export interface MailReceipt {
  response?: string;
  messageId?: string;
  accepted?: string[];
  rejected?: string[];
}

export interface Mailer {
  send(to: string, subject: string, text: string, html?: string, replyTo?: string): Promise<MailReceipt | void>;
}

// No SMTP configured → print the email to the server log (dev/test mode).
// Production must set SMTP_URL (SES / SendGrid / Resend / any SMTP).
class DevMailer implements Mailer {
  async send(to: string, subject: string, text: string, html?: string, replyTo?: string): Promise<MailReceipt> {
    console.log(`[mail:dev] To: ${to}${replyTo ? ` | Reply-To: ${replyTo}` : ""} | ${subject}\n${text}`);
    if (html) console.log(`[mail:dev:html] ${html.slice(0, 160)}…`);
    // Test hook: MAIL_DEV_DIR=/tmp/pd-mail makes emails readable from e2e
    // specs (verification / reset link extraction).
    const dir = process.env.MAIL_DEV_DIR;
    if (dir) {
      const safe = to.replace(/[^a-zA-Z0-9@._-]/g, "_");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, `${safe}.txt`),
        `Subject: ${subject}\n${replyTo ? `Reply-To: ${replyTo}\n` : ""}${text}\n\n---\n`,
      );
    }
    return { response: "not sent — no SMTP_URL configured (log-only mailer)" };
  }
}

class SmtpMailer implements Mailer {
  private transport: Transporter;
  private from: string;

  constructor(url: string, from: string) {
    this.transport = nodemailer.createTransport(url);
    this.from = from;
  }

  async send(to: string, subject: string, text: string, html?: string, replyTo?: string): Promise<MailReceipt> {
    const info = await this.transport.sendMail({ from: this.from, to, subject, text, ...(html ? { html } : {}), ...(replyTo ? { replyTo } : {}) });
    return {
      response: typeof info?.response === "string" ? info.response : undefined,
      messageId: typeof info?.messageId === "string" ? info.messageId : undefined,
      accepted: Array.isArray(info?.accepted) ? (info.accepted as string[]) : undefined,
      rejected: Array.isArray(info?.rejected) ? (info.rejected as string[]) : undefined,
    };
  }
}

let cached: Mailer | null = null;

export function getMailer(): Mailer {
  if (cached) return cached;
  const url = process.env.SMTP_URL;
  const from = process.env.EMAIL_FROM || "PixelDuo <no-reply@pixelduo.ai>";
  cached = url ? new SmtpMailer(url, from) : new DevMailer();
  return cached;
}

export function _setMailerForTests(mailer: Mailer | null) {
  cached = mailer;
}

// The outcome of the most recent send attempt, for the operator's own view.
//
// `mailDeliverable()` only proves SMTP_URL is set, which a wrong password also
// satisfies — the failure then shows up as silence (feedback nobody receives,
// password-reset links nobody gets). One slot, overwritten every time, so it
// costs nothing and exposes nothing: it is shown in the admin console only, and
// it is this PROCESS's last attempt (with several web replicas, whichever one
// served the request).
export interface MailAttempt {
  at: string;
  ok: boolean;
  to: string;
  subject: string;
  response?: string;
  error?: string;
}

let lastAttempt: MailAttempt | null = null;

export function lastMailAttempt(): MailAttempt | null {
  return lastAttempt;
}

export function _resetMailAttemptForTests() {
  lastAttempt = null;
}

// A refusal is not a transport failure, but the operator's question is the same
// one ("did anyone get told about this?") and the answer has to live in the same
// place: the console reads lastMailAttempt() and nothing else.
function recordMailRefusal(reason: string) {
  lastAttempt = {
    at: new Date().toISOString(),
    ok: false,
    to: "(none — FEEDBACK_TO is unset)",
    subject: "feedback (refused)",
    error: reason,
  };
}

// The single choke point every outbound mail passes through, so the record is
// about the mail path rather than about one caller: a broken password-reset mail
// matters more than a broken notification.
async function deliver(
  to: string,
  subject: string,
  text: string,
  html?: string,
  replyTo?: string,
): Promise<MailReceipt> {
  try {
    const receipt = (await getMailer().send(to, subject, text, html, replyTo)) ?? {};
    lastAttempt = { at: new Date().toISOString(), ok: true, to, subject, response: receipt.response };
    return receipt;
  } catch (e) {
    lastAttempt = {
      at: new Date().toISOString(),
      ok: false,
      to,
      subject,
      // Truncated like every other place we keep a transport error: it can carry
      // the SMTP host and the sender address, and nothing bounds its length.
      error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
    };
    throw e;
  }
}

function baseUrl(): string {
  return process.env.NEXTAUTH_URL ?? "http://localhost:3000";
}

// Global hourly ceiling on AUTHENTICATION mail (verification links and password
// resets), shared by every address and every source.
//
// The per-IP and per-account limits on those routes bound one sender against
// one mailbox; they say nothing about the total. Both routes are reachable
// without a session, both rotate the token they mail, and the addresses an
// attacker damages are not theirs to choose — but the SMTP quota is: it is
// shared with receipts, refunds and feedback notifications, and it is the same
// quota the feedback channel already protects with an hourly ceiling for
// exactly this reason ("a flood does not merely annoy, it can stop real users
// from receiving their links"). Verification and reset mail is the higher-value
// stream and had no ceiling at all, so N source addresses produced N×480 mails
// per day to one mailbox.
//
// Exceeding it never corrupts state: the caller skips the SEND (and, for the
// reset route, the token rotation with it, so a link already in the user's
// inbox keeps working) and the failure is announced in the log. It is a valve
// for an emergency, not a policy — 300/hour is far above any real signup flow.
const AUTH_MAIL_WINDOW_MS = 3600_000;
const DEFAULT_AUTH_MAIL_LIMIT = 300;
let lastAuthMailCapLog = 0;

// Reserve one slot in the hourly budget. False means "do not send": check this
// BEFORE creating the token a mail would carry, so a suppressed send cannot
// invalidate a link the user already has.
export async function reserveAuthMailSend(): Promise<boolean> {
  const limit = envLimit(process.env.AUTH_MAIL_HOURLY_LIMIT, DEFAULT_AUTH_MAIL_LIMIT);
  const r = await rateLimit("authmail:global", limit, AUTH_MAIL_WINDOW_MS);
  if (r.ok) return true;
  const now = Date.now();
  if (now - lastAuthMailCapLog > AUTH_MAIL_WINDOW_MS) {
    lastAuthMailCapLog = now;
    console.error(
      `[mail] auth mail ceiling reached (${limit}/hour) — verification and reset mails are being skipped until the window rolls over`,
    );
  }
  return false;
}

async function sendSafely(to: string, subject: string, text: string, html?: string): Promise<void> {
  try {
    await deliver(to, subject, text, html);
  } catch (e) {
    // Alert on delivery failures (Sentry when configured); rethrow so the API
    // surfaces a failure instead of silently dropping the verification link.
    captureError(e, { mailTo: to, mailSubject: subject });
    throw e;
  }
}

export async function sendVerificationEmail(to: string, rawToken: string): Promise<void> {
  const link = `${baseUrl()}/verify-email?token=${encodeURIComponent(rawToken)}`;
  await sendSafely(
    to,
    "Verify your PixelDuo email",
    [
      "Welcome to PixelDuo!",
      "",
      `Verify your email to activate your 30 free credits: ${link}`,
      "",
      "You'll be asked for the password you chose at sign-up — that is what proves the account is yours.",
      "",
      "The link expires in 24 hours. If you didn't create this account, ignore this email and reset the password instead.",
    ].join("\n"),
    verificationHtml(link),
  );
}

export async function sendResetPasswordEmail(to: string, rawToken: string): Promise<void> {
  const link = `${baseUrl()}/reset-password?token=${encodeURIComponent(rawToken)}`;
  await sendSafely(
    to,
    "Reset your PixelDuo password",
    [
      "We received a request to reset your PixelDuo password.",
      "",
      `Reset it here (expires in 1 hour): ${link}`,
      "",
      "If you didn't request this, you can safely ignore this email.",
    ].join("\n"),
    resetHtml(link),
  );
}

export async function sendCreditExpiryEmail(to: string, daysLeft: number, credits: number): Promise<void> {
  const dayLabel = daysLeft <= 1 ? "tomorrow" : `in ${daysLeft} days`;
  await sendSafely(
    to,
    `Your PixelDuo credits expire ${dayLabel}`,
    [
      `You have ${credits} credits expiring ${dayLabel}.`,
      "",
      "Use them before they're gone — or top up now to keep creating.",
      "",
      `https://pixelduo.ai/studio`,
    ].join("\n"),
    expiryHtml(daysLeft, credits),
  );
}

export async function sendOrderReceiptEmail(
  to: string,
  itemName: string,
  amountUsd: number,
  credits: number,
): Promise<void> {
  await sendSafely(
    to,
    `Your PixelDuo receipt — ${itemName}`,
    [
      `Thank you for your PixelDuo purchase!`,
      "",
      `Item: ${itemName}`,
      `Amount: $${amountUsd.toFixed(2)}`,
      `Credits added: ${credits}`,
      "",
      "You can view your order history any time in the workbench.",
      "",
      `https://pixelduo.ai/studio`,
    ].join("\n"),
    receiptHtml(itemName, amountUsd, credits),
  );
}

export async function sendRefundEmail(to: string, itemName: string, amountUsd: number): Promise<void> {
  await sendSafely(
    to,
    `Your PixelDuo refund — ${itemName}`,
    [
      `We processed a refund for your PixelDuo purchase:`,
      "",
      `Item: ${itemName}`,
      `Refunded amount: $${amountUsd.toFixed(2)}`,
      "",
      "The refund may take a few business days to appear on your statement.",
      "",
      `https://pixelduo.ai/studio`,
    ].join("\n"),
    refundHtml(itemName, amountUsd),
  );
}

// Two-factor state changes were silent, which makes a hostile enrollment
// indistinguishable from a legitimate one: a password-only attacker (breached
// or reused — no mailbox access needed) can sign in, bind 2FA to their own
// authenticator, and lock the victim out, because the self-service
// reset-password path deliberately does NOT clear totpEnabled — removing the
// second factor is exactly what 2FA exists to prevent, so mailbox access alone
// must not be able to strip it. The operator script that clears the binding
// manually (scripts/reset-2fa.ts) emails the owner on exactly this reasoning;
// the self-service routes must too. Deliberately NOT sendSafely: a mail outage
// must not fail the 2FA change the user just made, only report it.
//
// The remedy named below is the one that actually works. It used to say
// "reset your password immediately", which is false here in a way the owner
// only discovers while locked out: a reset rotates the password and revokes
// sessions + API keys (so the attacker is out — they do not know the new
// password) but leaves their authenticator bound, so the owner still needs the
// attacker's code to sign in and needs an operator to clear the binding.
export async function sendTwoFactorStateEmail(to: string, enabled: boolean): Promise<void> {
  const body = enabled
    ? [
        "Two-factor authentication is now active on your account. You will need your authenticator app (or a backup code) each time you sign in.",
        "",
        "All other sessions and all API keys were signed out by this change.",
        "",
        "If this wasn't you, reset your password immediately (that signs the attacker out), then ask support to clear the authenticator that was added — resetting the password alone does NOT remove a second factor someone else bound.",
      ]
    : [
        "Two-factor authentication has been turned off on your account. Sign-in now requires only your password.",
        "",
        "All other sessions and all API keys were signed out by this change.",
        "",
        "If this wasn't you, reset your password immediately and contact support.",
      ];
  try {
    await getMailer().send(
      to,
      enabled
        ? "Two-factor authentication was enabled on your PixelDuo account"
        : "Two-factor authentication was turned OFF on your PixelDuo account",
      body.concat(["", `https://pixelduo.ai/login`]).join("\n"),
    );
  } catch (e) {
    captureError(e, { mailTo: to, mailSubject: "2fa-state-change" });
  }
}

// Where user feedback is delivered. The operator's address is the default so a
// developer's local run (and the test suite) still reads as "reaches a human";
// FEEDBACK_TO overrides it (a support alias, a ticketing inbox, a mailing list).
//
// The default is a personal mailbox and it is NOT a deployment destination —
// see feedbackMailRefusal() below for why production never uses it.
export const FEEDBACK_TO_DEFAULT = "zhaijunwei0@gmail.com";
export function feedbackRecipient(): string {
  return process.env.FEEDBACK_TO || FEEDBACK_TO_DEFAULT;
}

// Why feedback mail can be refused before it is sent, or null when it may go.
//
// The built-in default is someone's personal Gmail. Every compose file
// forwarded SMTP_URL and EMAIL_FROM but not FEEDBACK_TO, so the documented
// container flow — set SMTP_URL, done — delivered every reporter's message
// body, their address, account id, plan, page and User-Agent to a third party
// while the operator's own inbox stayed empty and nothing anywhere reported a
// problem. A variable that reaches the app only if someone remembers to add it
// to a compose anchor is not a control, so production refuses to guess: with
// FEEDBACK_TO unset it declines to send at all, and says so through
// lastMailAttempt() (the admin console's "last outgoing mail failed" banner)
// plus captureError(). The message itself is still stored — the row is the
// record, and a missing recipient must never discard a user's report.
//
// Development and test keep the old behaviour: there the mailer is usually the
// log-only DevMailer anyway, and the pre-flight scripts and the test suite rely
// on the default being a real address.
export function feedbackMailRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if ((env.FEEDBACK_TO ?? "").trim()) return null;
  if (!isProductionRuntime(env)) return null;
  return (
    `FEEDBACK_TO is not set — refusing to send feedback notification to the built-in default address (${FEEDBACK_TO_DEFAULT}). ` +
    "Set FEEDBACK_TO to a mailbox your team reads (docs/deploy.md); the message is stored and visible in the admin console either way."
  );
}

// Everything the operator needs in order to act on a report. Each field is
// optional except the message: a signed-out report has no account behind it.
export interface FeedbackNotificationInput {
  ref: string;
  category: string;
  message: string;
  email: string;
  userId?: string | null;
  plan?: string | null;
  page?: string | null;
  locale?: string | null;
  userAgent?: string | null;
}

// One place builds the notification, so the pre-flight check below sends byte
// for byte what a real submission sends.
function buildFeedbackNotification(input: FeedbackNotificationInput) {
  const context = [
    `ref:      ${input.ref}`,
    `category: ${input.category}`,
    `from:     ${input.email}${input.userId ? ` (user ${input.userId})` : " (not signed in)"}`,
    `plan:     ${input.plan ?? "—"}`,
    `page:     ${input.page ?? "—"}`,
    `locale:   ${input.locale ?? "—"}`,
    `agent:    ${input.userAgent ?? "—"}`,
    `at:       ${new Date().toISOString()}`,
  ].join("\n");
  return {
    to: feedbackRecipient(),
    subject: `[PixelDuo] ${input.category} · ${input.email}`,
    text: `New feedback from the PixelDuo ${input.page ?? "app"}.\n\n${input.message}\n\n---\n${context}\n\nReply to this mail to answer ${input.email} directly.`,
    replyTo: input.email,
  };
}

// Notify the operator of a submitted message. Plain text on purpose: the body
// is user-written, and a text part cannot be an HTML injection surface in a
// mail client. Reply-To is the reporter, so answering in the mail client goes
// to them rather than back to the app's own From address.
//
// Deliberately NOT sendSafely: a mail outage must not turn a stored message
// into an error for the person who wrote it. The row is the record (it is what
// the admin console's feedback tab lists) and the failure is reported instead —
// same bargain as the 2FA state mail below.
export async function sendFeedbackEmail(input: FeedbackNotificationInput): Promise<void> {
  const refusal = feedbackMailRefusal();
  if (refusal) {
    // Same slot as a transport failure, so the console's "last outgoing mail
    // failed" banner carries the reason — a refusal that reported nowhere would
    // be indistinguishable from "nobody wrote in".
    recordMailRefusal(refusal);
    captureError(new Error(refusal), { mailTo: "feedback", mailSubject: "feedback" });
    return;
  }
  const msg = buildFeedbackNotification(input);
  try {
    await deliver(msg.to, msg.subject, msg.text, undefined, msg.replyTo);
  } catch (e) {
    captureError(e, { mailTo: msg.to, mailSubject: "feedback" });
  }
}

// The same notification, reporting what the receiving server answered instead
// of swallowing a failure. Only the pre-flight check uses it: "the operator
// receives feedback mail" is a deployment claim that has to be evidenced by the
// receiving MTA's own acceptance line, and that is the one thing the app's own
// send path deliberately does not surface.
//
// A refusal THROWS here rather than being recorded and skipped: for the app a
// suppressed notification is a stored row the operator can still read, but for
// the pre-flight it is the whole point of running the script, so it has to come
// back as a non-zero exit instead of a green "delivery OK" line.
export async function sendFeedbackEmailWithReceipt(input: FeedbackNotificationInput): Promise<MailReceipt> {
  const refusal = feedbackMailRefusal();
  if (refusal) throw new Error(refusal);
  const msg = buildFeedbackNotification(input);
  return deliver(msg.to, msg.subject, msg.text, undefined, msg.replyTo);
}

// True when mail is configured at all. Without SMTP_URL the app uses the
// log-only mailer, so an operator who never configured one would otherwise
// believe notifications are on their way to the feedback inbox. It says nothing
// about whether sending WORKS — that is what lastMailAttempt() answers.
export function mailDeliverable(): boolean {
  return Boolean(process.env.SMTP_URL);
}
