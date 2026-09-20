// SMTP provider presets, so nobody has to recall host/port/scheme — and so the
// 465-vs-587 trap is not a first-run failure: port 465 is TLS-from-the-first-byte
// and must be spelled `smtps://`, while `smtp://` on 465 (or `smtps://` on 587)
// just hangs until the timeout. Pure data + one pure function: no imports, so the
// setup script and the tests share it.
export interface MailPreset {
  id: string;
  label: string;
  // `credential` is the secret alone; `address` is the full mailbox when the
  // provider authenticates as the address itself (Gmail, QQ, 163, Aliyun).
  needs: Array<"credential" | "address" | "port">;
  build(input: { credential: string; address?: string; region?: string }): string;
  fromHint: string;
  notes?: string;
}

export const MAIL_PRESETS: MailPreset[] = [
  {
    id: "aliyun",
    label: "Aliyun DirectMail (smtpdm.aliyun.com) — most reliable from mainland China",
    needs: ["address", "credential"],
    // The username is the full sender address; the sending domain must be
    // verified in the DirectMail console first.
    build: ({ credential, address }) =>
      `smtps://${encodeURIComponent(address!)}:${encodeURIComponent(credential)}@smtpdm.aliyun.com:465`,
    fromHint: "PixelDuo <no-reply@your-verified-domain>",
    notes: "Verify the sending domain in the Aliyun DirectMail console first (控制台 → 发信域名).",
  },
  {
    id: "qq",
    label: "QQ Mail (smtp.qq.com) — needs the 授权码, not the login password",
    needs: ["address", "credential"],
    build: ({ credential, address }) => `smtps://${encodeURIComponent(address!)}:${encodeURIComponent(credential)}@smtp.qq.com:465`,
    fromHint: "the same QQ address",
    notes: "Settings → Account → 开启 SMTP 服务 → generate 授权码 (16 chars).",
  },
  {
    id: "163",
    label: "163 Mail (smtp.163.com) — needs the 授权码, not the login password",
    needs: ["address", "credential"],
    build: ({ credential, address }) => `smtps://${encodeURIComponent(address!)}:${encodeURIComponent(credential)}@smtp.163.com:465`,
    fromHint: "the same 163 address",
    notes: "Settings → POP3/SMTP/IMAP → 开启服务 → set the 客户端授权密码.",
  },
  {
    id: "resend",
    label: "Resend (smtp.resend.com) — verify your sending domain first",
    needs: ["credential"],
    build: ({ credential }) => `smtp://resend:${encodeURIComponent(credential)}@smtp.resend.com:587`,
    fromHint: "PixelDuo <no-reply@your-verified-domain>",
    notes: "Until the domain is verified, Resend only delivers from its own onboarding address.",
  },
  {
    id: "sendgrid",
    label: "SendGrid (smtp.sendgrid.net)",
    needs: ["credential"],
    build: ({ credential }) => `smtp://apikey:${encodeURIComponent(credential)}@smtp.sendgrid.net:587`,
    fromHint: "PixelDuo <no-reply@your-verified-domain>",
  },
  {
    id: "postmark",
    label: "Postmark (smtp.postmarkapp.com)",
    needs: ["credential"],
    build: ({ credential }) => `smtp://${encodeURIComponent(credential)}:${encodeURIComponent(credential)}@smtp.postmarkapp.com:587`,
    fromHint: "PixelDuo <no-reply@your-verified-domain>",
    notes: "The server token is both the username and the password.",
  },
  {
    id: "ses",
    label: "Amazon SES (email-smtp.<region>.amazonaws.com)",
    needs: ["credential", "address"],
    build: ({ credential, address, region }) =>
      `smtp://${encodeURIComponent(address ?? "")}:${encodeURIComponent(credential)}@email-smtp.${region ?? "us-east-1"}.amazonaws.com:587`,
    fromHint: "PixelDuo <no-reply@your-verified-domain>",
    notes: "Address = the SMTP username (AKIA…), credential = the SMTP password.",
  },
  {
    id: "gmail",
    label: "Gmail (smtp.gmail.com) — needs an app password; often unreachable from mainland China",
    needs: ["address", "credential"],
    build: ({ credential, address }) => `smtps://${encodeURIComponent(address!)}:${encodeURIComponent(credential)}@smtp.gmail.com:465`,
    fromHint: "the same Gmail address (Gmail rewrites a foreign From)",
    notes:
      "Enable 2FA, then create an app password at myaccount.google.com/apppasswords. From a mainland-China host prefer Aliyun/QQ/163.",
  },
  {
    id: "local",
    // For verifying the whole path with no provider account at all:
    //   node scripts/dev-smtp-sink.mjs 2525 /tmp/pd-smtp-inbox.log &
    label: "Local SMTP sink (development only — receives instead of delivering)",
    needs: ["port"],
    build: ({ address }) => `smtp://127.0.0.1:${Number(address) || 2525}`,
    fromHint: "PixelDuo <no-reply@pixelduo.ai>",
    notes: "Pairs with scripts/dev-smtp-sink.mjs; nothing is delivered to a real mailbox.",
  },
];

export function findPreset(id: string): MailPreset | undefined {
  return MAIL_PRESETS.find((p) => p.id === id);
}

// `smtps://` for 465 / `smtp://` for everything else — the one thing a hand-typed
// URL gets wrong most often.
export function schemeForPort(port: number): "smtps" | "smtp" {
  return port === 465 ? "smtps" : "smtp";
}
