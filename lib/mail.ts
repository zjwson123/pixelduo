import nodemailer, { type Transporter } from "nodemailer";
import fs from "fs";
import path from "path";
import { captureError } from "./observability";
import { quoteUntrusted } from "./untrusted-text";
import { isProductionRuntime, usableUrl } from "./runtime-env";
import { rateLimit, peekRateLimit, envLimit } from "./rate-limit";
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
    // Timeouts, because nodemailer's defaults are measured in TENS OF MINUTES
    // (30s greeting, 2min connect, 10min socket inactivity) and deliver() is
    // awaited from paths a user is waiting on: /api/feedback, /api/register,
    // the verification resend, 2FA confirm/disable — and the reminder cron walks
    // every grant sequentially. A provider that accepts the connection and then
    // goes quiet used to hold each of those for ten minutes per message.
    // Receipt and refund mail is already sent after the transaction commits, so
    // a timeout here costs a notification, never a payment.
    //
    // `url` as a FIELD, not as the string overload: nodemailer's second
    // parameter is message defaults, so `createTransport(url, {timeouts})`
    // silently ignores them. With `url` inside the options object its own
    // parseConnectionUrl does the parsing (percent-encoded credentials and all)
    // and the timeouts are part of the same options bag.
    this.transport = nodemailer.createTransport({
      url,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
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
  const from = process.env.EMAIL_FROM || "PixelDuo <no-reply@pixelduo.ai>";
  // mailDeliverable(), not `Boolean(process.env.SMTP_URL)`: a value that is set
  // but unusable (" ", an http:// paste, a hostless smtps://) selected the SMTP
  // transport and then failed EVERY send with a transport error, while the
  // log-only mailer at least delivers to the operator's log with a clear
  // "(dev mailer)" marker. Production refuses to boot on either, see
  // instrumentation.ts.
  cached = mailDeliverable() ? new SmtpMailer(process.env.SMTP_URL!.trim(), from) : new DevMailer();
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
// The budget is SPLIT BY STREAM, which is the fix for a hole the single counter
// had: `/api/register` is the cheap way to spend it (10/hour/IP and no session
// needed, while the reset route costs 5/15min/IP plus a known address, and its
// per-account cap applies only when the address exists). One shared counter
// therefore let a signup flood suppress PASSWORD RECOVERY for everyone for the
// rest of the hour — the highest-value mail here, and the only self-service way
// out of a login-guard lockout — for the price of the least valuable one. Two
// counters whose limits sum to the same total keep the SMTP-quota bound while
// making the two streams unable to starve each other: exhausting verification
// leaves the reset budget untouched, and vice versa. Verified mail is the
// volume stream (every signup, plus resends) and gets the larger share.
//
// Exceeding a ceiling never corrupts state: the caller skips the SEND (and, for
// the reset route, the token rotation with it, so a link already in the user's
// inbox keeps working). It is a valve for an emergency, not a policy — 300/hour
// is far above any real signup flow.
const AUTH_MAIL_WINDOW_MS = 3600_000;
const DEFAULT_AUTH_MAIL_LIMIT = 300;
// The recovery stream is the smaller slice: it needs far less throughput, and
// an attacker who wants to block recovery should have to spend the harder
// reset-side budget to do it rather than the trivial register-side one.
const RESET_MAIL_SHARE = 1 / 3;
let lastAuthMailCapLog: Record<string, number> = {};

export type AuthMailKind = "verify" | "reset";

function authMailBudget(kind: AuthMailKind, total: number): number {
  const reset = Math.max(1, Math.floor(total * RESET_MAIL_SHARE));
  return kind === "reset" ? reset : Math.max(1, total - reset);
}

// Whether a stream's hourly budget still has room, read WITHOUT spending it.
//
// `hit` (reserveAuthMailSend) is what makes a bucket attacker-spendable, so an
// answer derived from `hit` is only safe where the subject is already known to
// be real — otherwise the refusal itself discloses existence. This reads the
// counter instead: the answer depends only on the global budget, so it is
// identical for a real and an invented address, and it can be reported to the
// caller honestly instead of being hidden behind a uniform "sent".
export async function authMailBudgetAvailable(kind: AuthMailKind): Promise<boolean> {
  const total = envLimit(process.env.AUTH_MAIL_HOURLY_LIMIT, DEFAULT_AUTH_MAIL_LIMIT);
  const limit = authMailBudget(kind, total);
  const r = await peekRateLimit(`authmail:${kind}`, limit, AUTH_MAIL_WINDOW_MS);
  return r.ok;
}

// Reserve one slot in a stream's hourly budget. False means "do not send":
// check this BEFORE creating the token a mail would carry, so a suppressed send
// cannot invalidate a link the user already has.
export async function reserveAuthMailSend(kind: AuthMailKind): Promise<boolean> {
  const total = envLimit(process.env.AUTH_MAIL_HOURLY_LIMIT, DEFAULT_AUTH_MAIL_LIMIT);
  const limit = authMailBudget(kind, total);
  const r = await rateLimit(`authmail:${kind}`, limit, AUTH_MAIL_WINDOW_MS);
  if (r.ok) return true;
  const now = Date.now();
  // Throttled to one report per window per stream per process: the operator has
  // to be able to see this (it is the only signal that users are silently not
  // receiving links — the alternative was a console line nobody reads), but it
  // must not become a flood of its own.
  if (now - (lastAuthMailCapLog[kind] ?? 0) > AUTH_MAIL_WINDOW_MS) {
    lastAuthMailCapLog[kind] = now;
    const message =
      `[mail] ${kind} mail ceiling reached (${limit}/hour${
        kind === "reset" ? "" : `, of a ${total}/hour total`
      }) — ${kind === "reset" ? "password reset" : "verification"} mails are being skipped until the window rolls over`;
    console.error(message);
    captureError(new Error(message), { scope: "auth-mail-ceiling", stream: kind, limit });
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
//
// The reporter's own text is quoted line by line (quoteUntrusted, shared with
// the webhook channel): it is arbitrary multi-line text sitting directly above
// the machine-generated context block the operator triages from, so an unquoted
// message could reproduce that block — `ref:`, and `from: <address> (user
// <id>)` naming somebody else's account — byte for byte, above the real one.
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
    text: `New feedback from the PixelDuo ${input.page ?? "app"}.\n\n${quoteUntrusted(input.message)}\n\n---\n${context}\n\nReply to this mail to answer ${input.email} directly.`,
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

// Same message, to an explicit recipient.
//
// scripts/verify-mail.ts takes an address on the command line so an operator can
// prove a NEW support mailbox receives before pointing FEEDBACK_TO at it — and
// it REPORTED that address while sending to feedbackRecipient(), so the check
// printed "[OK] the receiving server accepted" about a mailbox that never got
// the mail (and suggested passing one, which changed nothing). Threading the
// recipient through is the whole fix; the message is byte for byte the same.
export async function sendFeedbackEmailToWithReceipt(
  input: FeedbackNotificationInput,
  to: string,
): Promise<MailReceipt> {
  const refusal = feedbackMailRefusal();
  if (refusal) throw new Error(refusal);
  const msg = buildFeedbackNotification(input);
  return deliver(to, msg.subject, msg.text, undefined, msg.replyTo);
}

/**
 * A one-off security notice (the login-abuse alert), through deliver().
 *
 * deliver() is the single choke point that records lastMailAttempt(), which is
 * what the admin console's "last outgoing mail" banner reads — and the abuse
 * alert was the one mail that called getMailer().send() directly, so the
 * operator's own view of the mail path stayed silent about exactly the message
 * they most need to confirm was delivered.
 */
export async function sendSecurityNoticeEmail(to: string, subject: string, text: string): Promise<void> {
  await deliver(to, subject, text);
}

// True when mail is configured at all. Without SMTP_URL the app uses the
// log-only mailer, so an operator who never configured one would otherwise
// believe notifications are on their way to the feedback inbox. It says nothing
// about whether sending WORKS — that is what lastMailAttempt() answers.
//
// "Configured" means the value can actually be used (usableUrl): a whitespace
// value or a hostless smtps:// is not a transport, and reporting it as one while
// every send fails is the failure this predicate exists to prevent. The boot
// assertion in production asks this same question, so the two can never
// disagree about whether mail is configured.
export function mailDeliverable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(usableUrl(env.SMTP_URL, ["smtp:", "smtps:"]));
}
