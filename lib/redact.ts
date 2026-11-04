import { loadCcProxyConfig } from "./keys";

// Mask common secret patterns before secrets ever reach logs/Sentry.
//
// This module is server/worker only: it reads the operator's credential sources,
// including ~/.cc-proxy/config.json via lib/keys. The edge and browser Sentry
// configs must not import it; they keep the URL-shape scrub in
// lib/sentry-scrub.ts, which is safe in every runtime.
const SECRET_PATTERNS: Array<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}/g,
  // Payment and first-party API keys in their bare form: Stripe's `sk_live_…`
  // does not match the `sk-` pattern above (underscore, not hyphen), and
  // Paddle's `pdl_live_…`/`pdl_sdbx_…` and this app's own `pd_live_…` match
  // nothing at all. The Authorization form is covered by the Bearer rule, but a
  // gateway/proxy error page that echoes a header value without the scheme
  // (pass 47's Job.error case) would otherwise carry the credential into a
  // customer's job history and the logs.
  /\b(?:sk|pdl|pd)_(?:live|test|sdbx)_[A-Za-z0-9_]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /x-amz-credential=[^&]{5,}/gi,
  /x-amz-signature=[^&]{5,}/gi,
  // Email addresses are PII in this codebase: Sentry's own query scrubber
  // already rewrites `email=`/`q=` parameters (lib/sentry-scrub.ts), but the
  // auth/transaction mail path passes `mailTo: user@example.com` as a CONTEXT
  // value and SMTP errors quote the recipient in their message — neither
  // matches a query parameter, so every failed verification/reset/receipt mail
  // shipped the end user's address to a third party (pass 41). Matched
  // anywhere, because the shapes this app produces are all bare addresses.
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
];

// Secret VALUES, not only secret shapes (pass 52). The patterns above recognise
// the prefixes this app and its vendors issue, but a provider key is not
// required to carry one: Volcengine/Ark credentials are bare UUIDs, and a
// gateway that rejects a request with `Incorrect API key provided: <value>`
// puts the operator's credential into Job.error — which is returned to the
// job's owner by /api/jobs, /api/jobs/[id] and the v1 poll. Passes 47/48 closed
// that hole for the `Bearer <token>` and `sk-…` spellings; the no-scheme,
// no-prefix spelling still went through untouched (probed). Every credential
// this process holds is known at redact time, so matching the value itself is
// both exact and prefix-independent.
//
// Sources: env vars whose NAME says they are credentials (keys can also live in
// ~/.cc-proxy/config.json, which the provider layer reads when the env is
// unset), comma/whitespace-separated key lists, and the userinfo password of a
// connection URL (SMTP_URL, and docker-compose.single.yml's `redis://:pw@…`).
// The length floor keeps ordinary config values ("us-east-1", "true",
// "postgres") out of the replacement set. Names that say PASSWORD/TOKEN/SECRET/
// KEY outright get the lower floor: a credential is a credential at 10
// characters, and the floor is only there to keep ambiguous values from being
// masked everywhere.
const SECRET_ENV_NAME = /(?:SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|PASSWORD|TOKEN|DSN|WEBHOOK)/i;
const STRONG_SECRET_ENV_NAME = /(?:SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|PASSWORD|TOKEN)$/i;
const MIN_SECRET_LEN = 12;
const MIN_STRONG_SECRET_LEN = 8;

function configuredSecrets(): string[] {
  const values: string[] = [];
  const add = (v: string | undefined | null, floor = MIN_SECRET_LEN) => {
    if (v && v.length >= floor) values.push(v);
  };
  for (const [name, raw] of Object.entries(process.env)) {
    if (!raw) continue;
    if (SECRET_ENV_NAME.test(name)) {
      const floor = STRONG_SECRET_ENV_NAME.test(name) ? MIN_STRONG_SECRET_LEN : MIN_SECRET_LEN;
      // The whole value first: a credential that contains whitespace is still
      // one credential, and splitting it would leave the middle unmatched.
      add(raw, floor);
      for (const part of raw.split(/[,\s]+/)) add(part, floor);
    }
    // `scheme://[user]:password@host` — the password, not the whole URL. The
    // userinfo NAME may be empty (docker-compose.single.yml builds Redis exactly
    // that way, and only REDIS_URL reaches the app), and an encoded password is
    // added in both spellings.
    if (/(?:_URL|_URI)$/i.test(name)) {
      const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^:\s/@]*):([^@\s/]+)@/i.exec(raw);
      if (m) {
        add(m[1], MIN_STRONG_SECRET_LEN);
        try {
          add(decodeURIComponent(m[1]), MIN_STRONG_SECRET_LEN);
        } catch {
          // Not valid percent-encoding: the raw spelling is still covered.
        }
      }
    }
  }
  try {
    for (const gw of Object.values(loadCcProxyConfig()?.gateways ?? {})) {
      for (const key of gw.api_keys ?? []) add(key, MIN_STRONG_SECRET_LEN);
    }
  } catch {
    // An unreadable config must not break error reporting.
  }
  // Longest first: replacing a shorter secret that happens to be a substring of
  // a longer one would leave the remainder of the longer key in place.
  return Array.from(new Set(values)).sort((a, b) => b.length - a.length);
}

export function redactSensitive(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  for (const secret of configuredSecrets()) {
    if (out.includes(secret)) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}
