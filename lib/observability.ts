import * as Sentry from "@sentry/node";
import { scrubSentryEvent } from "./sentry-scrub";
import { numberFromEnv } from "./runtime-env";

// Mask common secret patterns before secrets ever reach logs/Sentry.
const SECRET_PATTERNS: Array<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /x-amz-credential=[^&]{5,}/gi,
  /x-amz-signature=[^&]{5,}/gi,
];

export function redactSensitive(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

// The same treatment for the strings inside a context object.
//
// Redacting only the message was the gap: lib/api.ts passes the string it just
// redacted a second time, unredacted, as `{ error: msg }` — and a storage/SDK
// error's message is exactly where a presigned URL (so `X-Amz-Signature=…`)
// appears. Context goes verbatim to console.error AND to Sentry's `extra`, i.e.
// to a third party. One level is all any caller needs today; the walk is
// recursive so a nested object added later cannot slip through.
function redactContext(value: unknown, depth = 0): unknown {
  if (depth > 4) return value;
  if (typeof value === "string") return redactSensitive(value);
  if (Array.isArray(value)) return value.map((v) => redactContext(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value) as object | null;
    // Plain objects only — an Error or a Date must keep its identity.
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactContext(v, depth + 1);
    }
    return out;
  }
  return value;
}

// Shared observability for the worker / cron scripts. The Next.js app uses
// sentry.{server,client,edge}.config.ts via instrumentation.ts instead.
// Everything is a no-op unless SENTRY_DSN is set.
export function isSentryEnabled(): boolean {
  return Boolean(process.env.SENTRY_DSN);
}

export function initObservability(service: string): boolean {
  if (!isSentryEnabled()) return false;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    tracesSampleRate: numberFromEnv(process.env.SENTRY_TRACES_SAMPLE_RATE, 0.1),
    release: process.env.SENTRY_RELEASE,
    // The worker/rollover process is the one holding provider and moderator
    // credentials, and it does not go through the web process's configs: without
    // these two the shared scrubber simply does not run here, while the SDK's
    // default integrations still ship console output as breadcrumbs and
    // uncaught errors as events (both bypassing captureError, whose only
    // redaction is a message-shaped pattern list). Same function the three
    // sentry.*.config.ts files install, so the two surfaces cannot drift.
    beforeSend: (event) => scrubSentryEvent(event),
    beforeSendTransaction: (event) => scrubSentryEvent(event),
  });
  Sentry.setTag("service", service);
  return true;
}

export function captureError(err: unknown, context?: Record<string, unknown>) {
  const safeContext = context ? (redactContext(context) as Record<string, unknown>) : undefined;
  if (isSentryEnabled()) {
    Sentry.withScope((scope) => {
      if (safeContext && Object.keys(safeContext).length > 0) {
        scope.setContext("extra", safeContext);
      }
      const error = err instanceof Error ? err : new Error(String(err));
      const message = redactSensitive(error.message);
      Sentry.captureException(
        message === error.message ? error : new Error(message),
      );
    });
  }
  const msg = redactSensitive(err instanceof Error ? err.message : String(err));
  if (safeContext && Object.keys(safeContext).length > 0) {
    console.error(`[error] ${msg}`, JSON.stringify(safeContext));
  } else {
    console.error(`[error] ${msg}`);
  }
}
