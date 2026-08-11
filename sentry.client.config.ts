import * as Sentry from "@sentry/nextjs";

// Client-side DSN must be public-safe (NEXT_PUBLIC_*); server DSN fallback.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN ?? process.env.SENTRY_DSN;

export const isSentryEnabled = Boolean(dsn);

if (isSentryEnabled) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.SENTRY_ENVIRONMENT ?? "development",
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    release: process.env.SENTRY_RELEASE,
  });
}
