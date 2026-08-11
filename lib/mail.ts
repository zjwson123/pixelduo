import nodemailer, { type Transporter } from "nodemailer";
import fs from "fs";
import path from "path";

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

export async function sendVerificationEmail(to: string, rawToken: string): Promise<void> {
  const link = `${baseUrl()}/verify-email?token=${encodeURIComponent(rawToken)}`;
  await getMailer().send(
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
  await getMailer().send(
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
