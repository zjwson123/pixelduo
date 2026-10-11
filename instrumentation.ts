import { isProductionRuntime, usableUrl } from "./lib/runtime-env";
import { mailDeliverable } from "./lib/mail";

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

// The CI/e2e secret is a real 48-hex string, so it passes the length floor and
// contains no placeholder word — but it is published in .github/workflows/ci.yml
// and in scripts/ci-local.sh, which makes it the most likely value for an
// operator to copy into a deployment by accident, and anyone reading the public
// repository can then mint a session JWT for any account, admin included.
const PUBLISHED_CI_SECRET = "5c1f8e2a94b7d03f6ae4c81d2795bf30e6a1c47d8b92f650";

export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  // Fail closed on the ENVIRONMENT SPELLING, not on one exact string — see
  // lib/runtime-env.ts. These assertions used to run only when NODE_ENV was
  // exactly "production", so a deployment that spelled it any other way —
  // "staging", "prod", or left it unset in a custom entrypoint — skipped every
  // check below silently, taking NEXTAUTH_SECRET/SMTP_URL/NEXTAUTH_URL
  // enforcement with it (and, in lib/twofa.ts, the 2FA ticket signing key).
  if (!isProductionRuntime(env)) return;

  // NEXTAUTH_SECRET signs every session JWT and the 2FA pre-auth ticket, so a
  // placeholder (public knowledge — it ships in .env.example), a published CI
  // value, or a low-entropy value (brute-forceable offline from one captured
  // JWT) lets anyone mint a session for any account, admin included.
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
  // The published CI secret is checked against testDeployment rather than
  // against the placeholder list above: CI and ci-local.sh legitimately use it
  // to boot a production build, so it may only be rejected where it would be a
  // real deployment's signing key.
  //
  // Normalised (pass 34): the placeholder check beside it already lowercases
  // and substring-matches, so it survives case and stray characters — this one
  // compared the raw bytes, and the way a value travels out of a YAML/env file
  // (copy with the line's trailing space or newline, all-caps in transit) put it
  // back on the accepted side: a key that IS the public value modulo whitespace
  // and case let anyone reading this repository forge a session — admin
  // included — for the price of trying a handful of spellings. Trim and fold
  // case before comparing; the constant is lowercase hex, so nothing legitimate
  // is caught by this.
  if (secret.trim().toLowerCase() === PUBLISHED_CI_SECRET && !testDeployment) {
    throw new Error(
      "NEXTAUTH_SECRET is the value published in .github/workflows/ci.yml and scripts/ci-local.sh — it is public knowledge, so anyone could forge a session for any account. Generate a fresh one with `openssl rand -base64 32`",
    );
  }
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
    //
    // usableUrl rather than a prefix test, because "https://" (no host) and
    // "https://pixelduo.ai " both start with the right eight characters: the
    // first sends every generated link to nowhere and the second to a host that
    // does not exist. A URL this process cannot parse and address is not a
    // usable origin, and refusing to boot is the only signal that reaches the
    // operator before a user does.
    if (!usableUrl(env.NEXTAUTH_URL, ["https:"])) {
      throw new Error(
        "NEXTAUTH_URL must be a usable https:// URL (scheme + host) in production — next-auth issues a non-Secure session cookie (and mails http:// links) when it is not, and links built from a hostless value point nowhere",
      );
    }

    // Without SMTP_URL the mailer falls back to a stdout logger, so password
    // reset and email verification links — live account-takeover credentials —
    // are written to the container log while all auth mail for real users is
    // silently dropped. MAIL_DEV_MODE=1 is the explicit opt-in for that.
    //
    // "Set but unusable" is refused identically, through the SAME predicate the
    // mailer reports with (lib/mail.ts's mailDeliverable): SMTP_URL=" " made
    // nodemailer dial localhost:587 and SMTP_URL="smtps://" (no host) threw at
    // the first send, while both the boot check and the admin console's
    // "configured" banner called mail healthy.
    if (env.MAIL_DEV_MODE !== "1" && !mailDeliverable(env)) {
      throw new Error(
        "SMTP_URL is required in production, and must be a usable smtp:// or smtps:// URL with a host — without it verification/reset links are written to the container log and auth mail is dropped (set MAIL_DEV_MODE=1 to accept that)",
      );
    }
  }
}

// Resolve the payment provider BEFORE traffic. getPaymentProvider() throws for a
// typo'd PAYMENT_PROVIDER, for mock outside the mock flag, and for any settings
// it cannot serve (a missing STRIPE_WEBHOOK_SECRET / Paddle secret) — but it was
// only ever reached on the first checkout or webhook, so a deployment could boot
// healthy, 500 every checkout, and 500 EVERY webhook: the provider retries for
// days and then disables the endpoint, with money taken and no credits granted,
// while `docker compose ps` shows a healthy container. Every other configuration
// gate in this codebase fails closed at boot for exactly this reason (the
// moderation and mock-provider gates in scripts/worker.ts). Separate from
// assertProductionConfig because it needs a dynamic import — lib/payments pulls
// the Stripe and Paddle SDKs, which must not be bundled for the edge runtime —
// and because the env-object parameter that function is tested with cannot
// affect the SDKs' own process.env reads.
export async function assertPaymentProviderUsable(): Promise<void> {
  if (!isProductionRuntime()) return;
  try {
    const { getPaymentProvider } = await import("./lib/payments");
    getPaymentProvider();
  } catch (e) {
    throw new Error(
      `payment provider is not usable with the current configuration: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// Warnings for a configuration that is present and IGNORED.
//
// Not assertions: neither state is dangerous, both are worth a line in the log
// because the product degrades invisibly. getDeepSeekKey()/getDeepSeekBaseUrl()
// resolve the assistant's key and endpoint as ONE atomic pair (lib/keys.ts) —
// half of an override is returned as null rather than paired with the other half
// from some other source. Correct as a security rule, and it made a real
// misconfiguration silent: the compose anchors forwarded DEEPSEEK_API_KEY and
// named DEEPSEEK_BASE_URL in none of them, so following the documented "set the
// key" step produced an assistant that used its offline expander and smart
// routing its static default while the key sat in the container looking
// configured. Nothing in the UI says "the assistant is offline", so the operator
// gets a lesser feature rather than an error.
export function warnOnHalfSetIntegrations(env: NodeJS.ProcessEnv = process.env): void {
  const key = env.DEEPSEEK_API_KEY?.trim();
  const base = env.DEEPSEEK_BASE_URL?.trim();
  if (key && !base) {
    console.warn(
      "[config] DEEPSEEK_API_KEY is set but DEEPSEEK_BASE_URL is not — the pair is resolved atomically, so the key is ignored and the prompt assistant / smart routing fall back to their offline answers. Set both (DEEPSEEK_BASE_URL=https://api.deepseek.com for the vendor API, or your relay's base URL).",
    );
  }
  if (base && !key) {
    console.warn(
      "[config] DEEPSEEK_BASE_URL is set but DEEPSEEK_API_KEY is not — the pair is resolved atomically, so the endpoint is ignored and the prompt assistant / smart routing fall back to their offline answers.",
    );
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
      await assertPaymentProviderUsable();
      // The database session must be on UTC — see lib/prisma.ts's pin. The pin
      // there makes this true for every runtime this app controls; this gate is
      // what catches a DATABASE_URL whose own `options=` parameter (or a
      // transaction pooler that strips the one we append) left the session on
      // the server's local time, where every SQL-written deadline and schedule
      // in the money paths is off by the offset — silently, in both directions.
      // Dynamic import for the same reason as the payment gate above:
      // lib/prisma must not be bundled into the edge runtime.
      const { assertDatabaseSessionUtc } = await import("./lib/prisma");
      await assertDatabaseSessionUtc();
    } catch (e) {
      // Write to stderr and exit from the write callback: Docker captures
      // stdout as a PIPE (not a TTY), where a console.log write is asynchronous
      // and process.exit() can drop it — the operator then sees a bare restart
      // loop with no stated reason, which is the exact failure this line exists
      // to prevent. The exit still happens, so the guarantee is unchanged.
      const message = `[fatal] refusing to start: ${e instanceof Error ? e.message : String(e)}`;
      process.stderr.write(`${message}\n`, () => process.exit(1));
    }
    warnOnHalfSetIntegrations();
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}
