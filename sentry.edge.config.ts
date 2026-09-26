import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./lib/sentry-scrub";

const dsn = process.env.SENTRY_DSN;

export const isSentryEnabled = Boolean(dsn);

if (isSentryEnabled) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    release: process.env.SENTRY_RELEASE,
    // The same scrub the server and client configs apply, for the same reason:
    // a request URL reaches an event with its query string intact, and the query
    // string of /reset-password or /verify-email IS the account-takeover
    // credential. The edge runtime is where proxy.ts runs, so it sees every
    // /api/* request — including the auth callbacks that carry those links.
    beforeSend: (event) => scrubSentryEvent(event),
    beforeSendTransaction: (event) => scrubSentryEvent(event),
  });
}
