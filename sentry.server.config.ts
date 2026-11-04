import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./lib/sentry-scrub";
import { redactSensitive } from "./lib/redact";
import { numberFromEnv } from "./lib/runtime-env";

// All Sentry integration is a no-op unless SENTRY_DSN is set, so local dev
// and CI stay free of external dependencies.
const dsn = process.env.SENTRY_DSN;

export const isSentryEnabled = Boolean(dsn);

if (isSentryEnabled) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    tracesSampleRate: numberFromEnv(process.env.SENTRY_TRACES_SAMPLE_RATE, 0.1),
    release: process.env.SENTRY_RELEASE,
    // The request URL reaches events with its query string intact, and the
    // query string of /reset-password and /verify-email is an account-takeover
    // credential — see lib/sentry-scrub.ts. The redactor is the server-side
    // half: the SDK's default integrations ship uncaught errors and console
    // output as events/breadcrumbs without passing captureError, so configured
    // provider credentials in that text are masked here (pass 52).
    beforeSend: (event) => scrubSentryEvent(event, redactSensitive),
    beforeSendTransaction: (event) => scrubSentryEvent(event, redactSensitive),
  });
}
