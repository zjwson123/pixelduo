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
const SENSITIVE_QUERY_PARAM =
  /(^|[?&])((?:token|code|ticket|jti|secret|password|passwd|api_?key|access_?key|key|signature|sig|session|state)=)[^&#\s"'<>]*/gi;

// Depth/size bounds: an event is small, but this runs on every event and must
// never be the reason a report is lost or a process is slowed.
const MAX_DEPTH = 8;
const MAX_NODES = 5000;

function scrubString(value: string): string {
  return value.replace(SENSITIVE_QUERY_PARAM, "$1$2[Filtered]");
}

function scrubValue(value: unknown, depth: number, budget: { nodes: number }): unknown {
  if (budget.nodes-- <= 0 || depth > MAX_DEPTH) return value;
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, depth + 1, budget));
  }
  // Plain objects only: a Date, Buffer, Error or class instance is left alone
  // rather than cloned into something the SDK no longer understands.
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubValue(v, depth + 1, budget);
    }
    return out;
  }
  return value;
}

// Wired as beforeSend / beforeSendTransaction in both SDK configs. Returns the
// event unchanged in shape — only string values that carry a sensitive query
// parameter are rewritten, so a report stays as useful as it was.
export function scrubSentryEvent<T>(event: T): T {
  return scrubValue(event, 0, { nodes: MAX_NODES }) as T;
}

export { SENSITIVE_QUERY_PARAM as _sensitiveQueryParamForTests };
