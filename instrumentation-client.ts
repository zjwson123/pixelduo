import * as Sentry from "@sentry/nextjs";

// Client-side DSN must be public-safe, i.e. NEXT_PUBLIC_*. There used to be a
// `?? process.env.SENTRY_DSN` fallback here, which cannot work: Next only
// inlines NEXT_PUBLIC_* into the browser bundle (the others are property lookups
// on an env shim that is empty in the browser), so a deployment that set only
// SENTRY_DSN — which is what docs/deploy.md and both prod composes do — got a
// client SDK that silently never initialised. Set NEXT_PUBLIC_SENTRY_DSN for
// browser-side reporting; SENTRY_DSN still covers the server.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

export const isSentryEnabled = Boolean(dsn);

if (isSentryEnabled) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.SENTRY_ENVIRONMENT ?? "development",
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    release: process.env.SENTRY_RELEASE,
  });
}
