import nodemailer, { type Transporter } from "nodemailer";
import fs from "fs";
import path from "path";
import { captureError } from "./observability";

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

// No SMTP configured → print the email to the server log (dev/test mode).
// Production must set SMTP_URL (SES / SendGrid / Resend / any SMTP).
class DevMailer implements Mailer {
  async send(to: string, subject: string, text: string) {
    console.log(`[mail:dev] To: ${to} | ${subject}\n${text}`);
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

  async send(to: string, subject: string, text: string) {
    await this.transport.sendMail({ from: this.from, to, subject, text });
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

async function sendSafely(to: string, subject: string, text: string): Promise<void> {
  try {
    await getMailer().send(to, subject, text);
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
      "The link expires in 24 hours. If you didn't create this account, ignore this email.",
    ].join("\n"),
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
  );
}
