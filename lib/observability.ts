import * as Sentry from "@sentry/node";
import { scrubSentryEvent } from "./sentry-scrub";
import { numberFromEnv } from "./runtime-env";
import { redactSensitive } from "./redact";

// Re-exported for the call sites that already import it from here (lib/queue,
// scripts/worker). The implementation lives in lib/redact.ts so the Sentry
// beforeSend wire-up can use it without importing @sentry/node.
export { redactSensitive } from "./redact";

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
    // uncaught errors as events (both bypassing captureError). The redactor
    // masks the configured credential VALUES too (pass 52), not just the
    // message-shaped prefix list. Same pairing the server config installs, so
    // the two surfaces cannot drift.
    beforeSend: (event) => scrubSentryEvent(event, redactSensitive),
    beforeSendTransaction: (event) => scrubSentryEvent(event, redactSensitive),
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
