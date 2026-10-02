// One definition of "this process is a production deployment", shared by the
// boot assertions and by every guard that refuses a test-only escape hatch.
//
// The predicate is deliberately phrased as "not development and not test"
// rather than "== production". A deployment that spells NODE_ENV any other way
// — "staging", "prod", "Production", or leaves it unset in a custom entrypoint
// — is a deployment, and used to be treated as a dev machine by these guards:
// the mock payment provider self-fulfilled orders, test-mode Stripe/Paddle keys
// minted real credits from genuinely signed webhooks, and MOCK_IMAGE_PROVIDER
// served stub images for real credits. instrumentation.ts and lib/twofa.ts were
// fixed to this shape first; the payment and provider gates kept the old
// exact-string test, so one process could be "production enough" to demand an
// https NEXTAUTH_URL and a real NEXTAUTH_SECRET while still being "not
// production" for the money path.
//
// Skipping a guard is now something a runtime must ASK for by declaring itself
// development or test.
export function isProductionRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "development" && env.NODE_ENV !== "test";
}

// A number read from the environment, where an EMPTY value means "not set".
//
// `Number(value ?? fallback)` looks equivalent and is not: `Number("")` is 0,
// and a compose file that declares a variable it does not set renders it as an
// empty string, so every container deployment ran SENTRY_TRACES_SAMPLE_RATE as
// 0 while the code default (and .env.example) said 0.1 — tracing off, silently,
// in exactly the environment that needs it. Empty and unparsable both fall back.
export function numberFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// A URL that is present, parseable, uses one of the expected schemes, and has a
// hostname. A bare truthiness test and a prefix test both accept values that
// cannot work: a single space makes nodemailer's transport dial localhost,
// "https://" (no host) makes every generated link point nowhere, and in both
// cases the boot/health signals report the feature as configured while every
// message is dropped. Returns null when the value is unusable, so a caller can
// treat "set but broken" exactly like "not set" instead of finding out one
// failed send at a time.
// Deadline for ONE outbound call — a provider/LLM request in lib/store.ts, an
// S3/MinIO request in lib/storage.ts — when the call site has no more specific
// value. Overridable so a test can exercise a deadline without waiting the
// production interval out, and it lives here rather than in lib/store.ts
// because lib/store.ts imports lib/storage.ts: an S3 deadline that had to be
// imported from the store would be a cycle.
export function outboundTimeoutMs(defaultMs: number): number {
  const raw = Number(process.env.OUTBOUND_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : defaultMs;
}

export function usableUrl(raw: string | undefined, protocols: string[]): URL | null {
  if (!raw || raw.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!protocols.includes(url.protocol)) return null;
  if (!url.hostname) return null;
  return url;
}
