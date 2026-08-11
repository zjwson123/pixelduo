import * as Sentry from "@sentry/node";

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
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    release: process.env.SENTRY_RELEASE,
  });
  Sentry.setTag("service", service);
  return true;
}

export function captureError(err: unknown, context?: Record<string, unknown>) {
  if (isSentryEnabled()) {
    Sentry.withScope((scope) => {
      if (context && Object.keys(context).length > 0) {
        scope.setContext("extra", context);
      }
      const error = err instanceof Error ? err : new Error(String(err));
      const message = redactSensitive(error.message);
      Sentry.captureException(
        message === error.message ? error : new Error(message),
      );
    });
  }
  const msg = redactSensitive(err instanceof Error ? err.message : String(err));
  if (context && Object.keys(context).length > 0) {
    console.error(`[error] ${msg}`, JSON.stringify(context));
  } else {
    console.error(`[error] ${msg}`);
  }
}
