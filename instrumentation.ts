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

// Can an http:// NEXTAUTH_URL reach only its own machine/LAN (pass 62)?
//
// The test-deployment escape hatch must not extend to a public hostname: an
// internet-facing mock deployment would mint unprefixed, non-Secure auth
// cookies, and a sibling subdomain of that name could plant them. Literal
// checks only — this runs at boot, before any resolver is worth trusting, and
// a hostname that needs DNS is not provably local.
export function isLocalOrPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1") return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  const m = /^172\.(\d+)\.\d+\.\d+$/.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  // IPv6 ULA (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  return false;
}

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
  // Length and placeholder matching are not entropy: a 32-character repeated
  // pattern ("abcabc…", "0123456789…") passed both while carrying a handful of
  // bits. Reject a short period and a tiny alphabet outright; a real
  // `openssl rand` value (hex or base64) has neither.
  const periodic = Array.from({ length: 16 }, (_, i) => i + 1).some(
    (p) => secret.length % p === 0 && secret === secret.slice(0, p).repeat(secret.length / p),
  );
  if (
    secret.length < 32 ||
    PLACEHOLDER_SECRETS.some((p) => lower.includes(p)) ||
    lower === "secret" ||
    periodic ||
    new Set(secret).size < 8
  ) {
    throw new Error(
      "NEXTAUTH_SECRET is missing, shorter than 32 characters, still a placeholder, or carries too little entropy — generate one with `openssl rand -base64 32`",
    );
  }

  // EMAIL_VERIFY_AUTO auto-verifies every registration AND releases the signup
  // bonus, so a stale value left over from CI turns registration into an
  // unlimited supply of verified, credit-bearing accounts. The explicit
  // PAYMENT_ALLOW_MOCK flag alongside the MOCK provider marks a deployment as
  // test-only (both CI and ci-local.sh set it), so it is the escape hatch —
  // reused below for the two checks that a legitimate test deployment must be
  // allowed to skip.
  //
  // The flag alone is NOT enough (pass 51). It also spelled "this is a test
  // deployment" while the configured provider was Stripe or Paddle: a leftover
  // flag in a host/CI environment made a production deployment accept the
  // PUBLIC CI signing secret (anyone can forge an admin session), an http://
  // NEXTAUTH_URL (non-Secure cookie), a missing SMTP_URL (reset links only in
  // the logs) and EMAIL_VERIFY_AUTO=1 (unlimited verified credit-bearing
  // accounts) — while real money was being taken by a real provider, so the
  // "mock is already refused in production" justification did not hold. The
  // hatch now requires the provider to actually resolve to the mock one.
  const providerName = env.PAYMENT_PROVIDER ?? "";
  const testDeployment =
    env.PAYMENT_ALLOW_MOCK === "1" && (providerName === "" || providerName === "mock");
  // Resolved here because the published-secret exemption below needs the host
  // as well as the flag (pass 63). The URL itself is checked further down; this
  // is the same parse, not a second policy.
  const authUrl = usableUrl(env.NEXTAUTH_URL, ["https:", "http:"]);
  // The published CI secret is checked against testDeployment rather than
  // against the placeholder list above: CI and ci-local.sh legitimately use it
  // to boot a production build, so it may only be rejected where it would be a
  // real deployment's signing key.
  //
  // A test deployment is not enough on a PUBLIC host (pass 63). `PAYMENT_
  // ALLOW_MOCK=1 PAYMENT_PROVIDER=mock NEXTAUTH_SECRET=<published>
  // NEXTAUTH_URL=https://app.example.com` passed this gate — the mock flags
  // only say "no real money", not "nobody outside this machine can reach it" —
  // and every session JWT for that deployment, admin included, is forgeable by
  // anyone who has read the repository. The exemption is now a test deployment
  // on a loopback/private host, which is what CI and ci-local.sh are; a public
  // test deployment must generate its own secret, which costs nothing.
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
  const localTestOrigin =
    testDeployment && authUrl !== null && isLocalOrPrivateHostname(authUrl.hostname);
  if (secret.trim().toLowerCase() === PUBLISHED_CI_SECRET && !localTestOrigin) {
    throw new Error(
      "NEXTAUTH_SECRET is the value published in .github/workflows/ci.yml and scripts/ci-local.sh — it is public knowledge, so anyone could forge a session for any account. Generate a fresh one with `openssl rand -base64 32`",
    );
  }
  if (env.EMAIL_VERIFY_AUTO === "1" && !testDeployment) {
    throw new Error(
      "EMAIL_VERIFY_AUTO=1 is not allowed in production — it auto-verifies registrations and grants the signup bonus",
    );
  }
  // Same reasoning as EMAIL_VERIFY_AUTO, and the sibling gate the worker reads
  // (lib/providers/index.ts mockImageProviderEnabled) now agrees with this one
  // (pass 62): stub output for real credits is a test-only behaviour. Checking
  // it here makes the misconfiguration a startup failure rather than a worker
  // that boots and quietly serves 1×1 PNGs while checkout takes money.
  if (env.MOCK_IMAGE_PROVIDER === "1" && !testDeployment) {
    throw new Error(
      "MOCK_IMAGE_PROVIDER=1 is only allowed in a test deployment (PAYMENT_ALLOW_MOCK=1 and PAYMENT_PROVIDER unset or mock) — it would serve stub images for real credits",
    );
  }

  // Webhook signing secrets are bearer-equivalent: whoever knows one can forge
  // `checkout.session.completed` / `transaction.completed` for a pending order
  // and receive its credits without paying. The provider constructors only
  // check that the value EXISTS, and the live-key gates beside them do not
  // examine it — so the test value published in this repository
  // (`whsec_test`: scripts/test-webhook.ts's default and the value
  // docs/archive/progress.md records in a compose run) booted a production
  // deployment clean, one POST away from free credits for anyone who has read
  // the repo.
  //
  // Checked for every configured secret, not just the selected provider's:
  // getWebhookVerifiers() accepts an alternate provider's header when its
  // secret is set, and a forged delivery for an order created before a provider
  // switch would still fulfil.
  const PUBLISHED_WEBHOOK_SECRETS = ["whsec_test", "whsec_ci", "pdl_ntfset_test", "pdl_whsec_test", "pdl_whsec_ci"];
  if (!testDeployment) {
    for (const varName of ["STRIPE_WEBHOOK_SECRET", "PADDLE_WEBHOOK_SECRET"]) {
      const raw = env[varName] ?? "";
      // Unset (or explicitly empty) is "not configured" — a deployment using
      // the other provider legitimately leaves this alone, and a selected
      // provider with no secret is refused by its constructor. Set-but-BLANK is
      // not "not configured": it is a placeholder that used to pass this gate
      // while the provider constructor accepted the raw whitespace as the HMAC
      // key (pass 61). Refuse it here, where the operator sees the variable's
      // name at boot.
      if (!raw) continue;
      const value = raw.trim().toLowerCase();
      if (!value) {
        throw new Error(
          `${varName} is set but blank (whitespace only) — a whitespace signing key is a published key. Set the secret from the provider dashboard, or unset the variable if this provider is not in use`,
        );
      }
      if (
        value.length < 16 ||
        PUBLISHED_WEBHOOK_SECRETS.includes(value) ||
        PLACEHOLDER_SECRETS.some((p) => value.includes(p))
      ) {
        throw new Error(
          `${varName} is shorter than 16 characters, still a placeholder, or a value published in this repository — anyone holding it can forge a paid webhook for a pending order. Copy the signing secret from the provider dashboard`,
        );
      }
    }
  }

  // next-auth derives the cookie's Secure flag AND the __Host-/__Secure- prefix
  // from this URL's scheme alone (useSecureCookies = url.startsWith("https://")).
  // An http:// value here fails silently: the app is healthy, HSTS is still
  // sent, but the session cookie goes out without Secure — readable on any
  // plaintext request to the domain — and every verification/reset email links
  // to the wrong host. It also reopens the pass-53 sibling-subdomain fixation:
  // unprefixed `next-auth.session-token`/`next-auth.csrf-token` accept a Domain
  // attribute, so a hostile sibling can plant them.
  //
  // The test-deployment hatch covers http:// ON A LOCAL/PRIVATE HOST only
  // (pass 62). It was `if (!testDeployment)` around this whole block, so a
  // mock deployment — the shipped local compose defaults, or a host-run
  // instance — could be put on a real public domain over http with
  // PAYMENT_ALLOW_MOCK=1 and mint those plantable cookies, which is the same
  // class passes 53/57/58 fixed in the predicate itself. Loopback/private hosts
  // are not addressable by a sibling-subdomain attacker, so they keep working.
  //
  // usableUrl rather than a prefix test, because "https://" (no host) and
  // "https://pixelduo.ai " both start with the right eight characters: the
  // first sends every generated link to nowhere and the second to a host that
  // does not exist. A URL this process cannot parse and address is not a
  // usable origin, and refusing to boot is the only signal that reaches the
  // operator before a user does. (authUrl was resolved above for the
  // published-secret host check.)
  const testHttpAllowed =
    testDeployment && authUrl?.protocol === "http:" && isLocalOrPrivateHostname(authUrl.hostname);
  if (!authUrl || (authUrl.protocol !== "https:" && !testHttpAllowed)) {
    throw new Error(
      "NEXTAUTH_URL must be a usable https:// URL (scheme + host) in production — next-auth issues a non-Secure, unprefixed session cookie (and mails http:// links) when it is not, and links built from a hostless value point nowhere. An http:// URL is accepted only for a test deployment on a loopback/private host",
    );
  }

  if (!testDeployment) {
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
