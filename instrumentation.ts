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
  // and ci-local.sh set it), so it is the escape hatch.
  if (env.EMAIL_VERIFY_AUTO === "1" && env.PAYMENT_ALLOW_MOCK !== "1") {
    throw new Error(
      "EMAIL_VERIFY_AUTO=1 is not allowed in production — it auto-verifies registrations and grants the signup bonus",
    );
  }
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    assertProductionConfig();
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}
