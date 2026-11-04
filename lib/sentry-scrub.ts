// Redact credentials that ride in URLs from anything Sentry would ship.
//
// A password-reset or verification link carries its token in the QUERY STRING
// (`/reset-password?token=…`, `/verify-email?token=…`) and the token IS the
// credential: consuming it sets a new password, bumps sessionVersion and
// revokes every API key. Sentry attaches the full URL — query string included —
// to every event by default: `httpContextIntegration` on the browser sets
// `event.request.url` from `window.location.href`, and the server's
// request-data integration carries the URL too (the SDK comments say it
// explicitly: "URL is always included"). PII filtering (sendDefaultPii unset)
// only strips headers/cookies and *parameter keys* it recognises — the URL
// itself is exempt. So one unhandled client error on that page, or one sampled
// transaction, shipped a working account-takeover credential to a third-party
// SaaS. Breadcrumbs carry the same URLs (`from`/`to` on a navigation, `url` on
// a fetch), and so can a message body.
//
// Value-shaped on purpose rather than page-shaped: it redacts by parameter NAME
// ANYWHERE in the event, so it also covers URLs we do not enumerate, query
// strings built at runtime, and pages added later. `denyUrls: [/\/reset-password/]`
// would have covered only the two pages that exist today and would also drop
// every unrelated error on them.
// Anchored on a query-parameter POSITION — either after `?`/`&`, or at the very
// start of the string (Sentry's `request.query_string` is a bare `a=1&b=2` with
// no leading delimiter). A path segment that merely contains a keyword is not
// touched.
// The list has to cover the shapes THIS codebase treats as credentials, not just
// the two it was written for: `access_token=` is DingTalk's group-bot credential
// (lib/notify.ts posts to it, and maskSecretUrl in lib/mail-check.ts already
// refuses to print it), and a presigned S3/R2 URL carries its capability in
// `X-Amz-Signature` / `X-Amz-Credential` / `X-Amz-Security-Token`. All of those
// used to pass through untouched — `token` never matched `access_token`, because
// the character before it is `_` and not `?`/`&`. A group-bot token in a Sentry
// project is the ability to post arbitrary messages as the bot.
//
// Pass 32 added the USER-CONTENT half. The rule above was only ever applied to
// credentials, but this app's own client code puts more than tokens in query
// strings: the workbench sends the user's search text (`/api/templates?q=…`,
// components/workbench.tsx) and the admin console sends an email/name fragment
// (`/api/admin/users?q=…`). Sentry ships fetch URLs in breadcrumbs and keeps
// the full href in span attributes, so both landed in a third-party tracker —
// user-authored text and user emails, in any deployment with a DSN. Still
// value-shaped and still by parameter name, so the same rule covers it.
const SENSITIVE_QUERY_PARAM =
  /(^|[?&])((?:token|code|ticket|jti|secret|password|passwd|api_?key|access_?key|access_?token|key|signature|sig|session|state|x-amz-signature|x-amz-credential|x-amz-security-token|q|email|user_?id)=)[^&#\s"'<>]*/gi;

// Path-shaped credentials, which no query-parameter rule can see: Feishu's
// webhook token is the last path segment (`/open-apis/bot/v2/hook/<uuid>`).
// 20 characters is the floor — nothing shorter is a credential on any endpoint
// this app supports, and the same shape is what maskSecretUrl masks.
const SENSITIVE_PATH_TOKEN = /(\/hook\/)[A-Za-z0-9_-]{20,}/gi;

// Depth/size bounds: an event is small, but this runs on every event and must
// never be the reason a report is lost or a process is slowed.
const MAX_DEPTH = 8;
const MAX_NODES = 5000;

function scrubString(value: string, redactValue?: (text: string) => string): string {
  // The value-shaped mask runs FIRST on the server/worker, where the operator's
  // configured credentials are readable (pass 52): a gateway can echo a bare
  // UUID key in an exception message or a console breadcrumb, and the SDK's own
  // integrations ship uncaught errors and console output without going through
  // captureError. The edge/browser configs pass no redactor — they hold no
  // provider credentials, and importing lib/redact there would pull in fs.
  const masked = redactValue ? redactValue(value) : value;
  return masked
    .replace(SENSITIVE_QUERY_PARAM, "$1$2[Filtered]")
    .replace(SENSITIVE_PATH_TOKEN, "$1[Filtered]");
}

function scrubValue(
  value: unknown,
  depth: number,
  budget: { nodes: number },
  redactValue?: (text: string) => string,
): unknown {
  if (budget.nodes-- <= 0 || depth > MAX_DEPTH) return value;
  if (typeof value === "string") return scrubString(value, redactValue);
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, depth + 1, budget, redactValue));
  }
  // Plain objects only: a Date, Buffer, Error or class instance is left alone
  // rather than cloned into something the SDK no longer understands.
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubValue(v, depth + 1, budget, redactValue);
    }
    return out;
  }
  return value;
}

// Wired as beforeSend / beforeSendTransaction in both SDK configs. Returns the
// event unchanged in shape — only string values that carry a sensitive query
// parameter or a configured credential are rewritten, so a report stays as
// useful as it was.
export function scrubSentryEvent<T>(event: T, redactValue?: (text: string) => string): T {
  return scrubValue(event, 0, { nodes: MAX_NODES }, redactValue) as T;
}

export { SENSITIVE_QUERY_PARAM as _sensitiveQueryParamForTests };
