// Boot-time configuration assertions. These run once per process, before the
// app serves traffic, so a dangerous misconfiguration is a startup failure
// instead of a silently exploitable deployment.
const PLACEHOLDER_SECRETS = [
  "changeme",
  "change-me",
  "change_me",
  "replace-me",
  "replace_me",
  "your-secret",
  "your_secret",
  "example",
  "ci-secret",
  "test-secret",
  "dev-secret",
  "default-secret",
  "nextauth-secret",
];

export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;

  // NEXTAUTH_SECRET signs every session JWT and the 2FA pre-auth ticket, so a
  // placeholder (public knowledge — it ships in .env.example) or a low-entropy
  // value (brute-forceable offline from one captured JWT) lets anyone mint a
  // session for any account, admin included.
  const secret = env.NEXTAUTH_SECRET ?? "";
  const lower = secret.toLowerCase();
  if (secret.length < 32 || PLACEHOLDER_SECRETS.some((p) => lower.includes(p)) || lower === "secret") {
    throw new Error(
      "NEXTAUTH_SECRET is missing, shorter than 32 characters, or still a placeholder — generate one with `openssl rand -base64 32`",
    );
  }

  // EMAIL_VERIFY_AUTO auto-verifies every registration AND releases the signup
  // bonus, so a stale value left over from CI turns registration into an
  // unlimited supply of verified, credit-bearing accounts. The explicit
  // PAYMENT_ALLOW_MOCK flag already marks a deployment as test-only (both CI
  // and ci-local.sh set it), so it is the escape hatch — reused below for the
  // two checks that a legitimate test deployment must be allowed to skip.
  const testDeployment = env.PAYMENT_ALLOW_MOCK === "1";
  if (env.EMAIL_VERIFY_AUTO === "1" && !testDeployment) {
    throw new Error(
      "EMAIL_VERIFY_AUTO=1 is not allowed in production — it auto-verifies registrations and grants the signup bonus",
    );
  }

  if (!testDeployment) {
    // next-auth derives the cookie's Secure flag AND the __Secure- prefix from
    // this URL's scheme alone (useSecureCookies = url.startsWith("https://")).
    // An http:// value here fails silently: the app is healthy, HSTS is still
    // sent, but the session cookie goes out without Secure — readable on any
    // plaintext request to the domain — and every verification/reset email
    // links to the wrong host.
    if (!(env.NEXTAUTH_URL ?? "").startsWith("https://")) {
      throw new Error(
        "NEXTAUTH_URL must be an https:// URL in production — next-auth issues a non-Secure session cookie (and mails http:// links) when it is not",
      );
    }

    // Without SMTP_URL the mailer falls back to a stdout logger, so password
    // reset and email verification links — live account-takeover credentials —
    // are written to the container log while all auth mail for real users is
    // silently dropped. MAIL_DEV_MODE=1 is the explicit opt-in for that.
    if (!env.SMTP_URL && env.MAIL_DEV_MODE !== "1") {
      throw new Error(
        "SMTP_URL is required in production — without it verification/reset links are written to the container log and auth mail is dropped (set MAIL_DEV_MODE=1 to accept that)",
      );
    }
  }
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // A misconfiguration must stop the process, not just reject this promise:
    // Next catches a register() rejection, logs "Failed to prepare server" and
    // keeps listening, so the container stayed "up" serving 500s on every
    // dynamic route while `restart: unless-stopped` never recycled it. Exiting
    // explicitly is what makes the assertion a real startup failure.
    try {
      assertProductionConfig();
    } catch (e) {
      console.error(`[fatal] refusing to start: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}
