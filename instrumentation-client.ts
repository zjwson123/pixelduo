import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./lib/sentry-scrub";
import { numberFromEnv } from "./lib/runtime-env";

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
    // Same trap as the DSN above, two lines lower: NEXT_PUBLIC_* is the only
    // form Next inlines into the browser bundle, so `process.env.SENTRY_ENVIRONMENT`
    // is a lookup on an empty shim and every browser event was filed under
    // "development" while the server filed its own under the real environment —
    // the production dashboard stayed empty for exactly the errors real users hit.
    // NODE_ENV is inlined by the bundler, so `||` on it keeps a dev build labelled
    // as one instead of pretending to be production.
    environment:
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ||
      (process.env.NODE_ENV === "production" ? "production" : "development"),
    tracesSampleRate: numberFromEnv(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE, 0.1),
    release: process.env.SENTRY_RELEASE,
    // `httpContextIntegration` puts window.location.href — query string and all
    // — on every event, and the browser is where the reset/verify token lives.
    // See lib/sentry-scrub.ts.
    beforeSend: (event) => scrubSentryEvent(event),
    beforeSendTransaction: (event) => scrubSentryEvent(event),
  });
}
