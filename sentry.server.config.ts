import * as Sentry from "@sentry/nextjs";

// All Sentry integration is a no-op unless SENTRY_DSN is set, so local dev
// and CI stay free of external dependencies.
const dsn = process.env.SENTRY_DSN;

export const isSentryEnabled = Boolean(dsn);

if (isSentryEnabled) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    release: process.env.SENTRY_RELEASE,
  });
}
