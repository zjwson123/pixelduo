import nodemailer, { type Transporter } from "nodemailer";
import fs from "fs";
import path from "path";
import { captureError } from "./observability";
import {
  verificationHtml,
  resetHtml,
  receiptHtml,
  refundHtml,
  expiryHtml,
} from "./mail-html";

export interface Mailer {
  send(to: string, subject: string, text: string, html?: string): Promise<void>;
}

// No SMTP configured → print the email to the server log (dev/test mode).
// Production must set SMTP_URL (SES / SendGrid / Resend / any SMTP).
class DevMailer implements Mailer {
  async send(to: string, subject: string, text: string, html?: string) {
    console.log(`[mail:dev] To: ${to} | ${subject}\n${text}`);
    if (html) console.log(`[mail:dev:html] ${html.slice(0, 160)}…`);
    // Test hook: MAIL_DEV_DIR=/tmp/pd-mail makes emails readable from e2e
    // specs (verification / reset link extraction).
    const dir = process.env.MAIL_DEV_DIR;
    if (dir) {
      const safe = to.replace(/[^a-zA-Z0-9@._-]/g, "_");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `${safe}.txt`), `Subject: ${subject}\n${text}\n\n---\n`);
    }
  }
}

class SmtpMailer implements Mailer {
  private transport: Transporter;
  private from: string;

  constructor(url: string, from: string) {
    this.transport = nodemailer.createTransport(url);
    this.from = from;
  }

  async send(to: string, subject: string, text: string, html?: string) {
    await this.transport.sendMail({ from: this.from, to, subject, text, ...(html ? { html } : {}) });
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

function baseUrl(): string {
  return process.env.NEXTAUTH_URL ?? "http://localhost:3000";
}

async function sendSafely(to: string, subject: string, text: string, html?: string): Promise<void> {
  try {
    await getMailer().send(to, subject, text, html);
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
// authenticator, and the victim is locked out permanently, because the
// self-service reset-password path revokes credentials but does NOT clear
// totpEnabled. The operator script that clears it manually
// (scripts/reset-2fa.ts) emails the owner on exactly this reasoning; the
// self-service routes must too. Deliberately NOT sendSafely: a mail outage
// must not fail the 2FA change the user just made, only report it.
export async function sendTwoFactorStateEmail(to: string, enabled: boolean): Promise<void> {
  const body = enabled
    ? [
        "Two-factor authentication is now active on your account. You will need your authenticator app (or a backup code) each time you sign in.",
        "",
        "All other sessions and all API keys were signed out by this change.",
      ]
    : [
        "Two-factor authentication has been turned off on your account. Sign-in now requires only your password.",
        "",
        "All other sessions and all API keys were signed out by this change.",
      ];
  try {
    await getMailer().send(
      to,
      enabled
        ? "Two-factor authentication was enabled on your PixelDuo account"
        : "Two-factor authentication was turned OFF on your PixelDuo account",
      body
        .concat([
          "",
          "If this wasn't you, reset your password immediately — someone may have your password.",
          "",
          `https://pixelduo.ai/login`,
        ])
        .join("\n"),
    );
  } catch (e) {
    captureError(e, { mailTo: to, mailSubject: "2fa-state-change" });
  }
}
