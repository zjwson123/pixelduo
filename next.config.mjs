import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://*.ingest.sentry.io https://*.sentry.io; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'",
          },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

// Only wrap with Sentry when a DSN is configured; otherwise the build and
// runtime stay untouched (source-map upload is skipped without an auth token).
// Source maps are turned off unless SENTRY_AUTH_TOKEN can actually upload
// them: @sentry/nextjs deletes them only AFTER a successful upload, so a
// DSN-without-token deployment would otherwise ship the complete original
// TypeScript of the client bundle (and .next/server) to anyone who fetches a
// chunk.map — free reconnaissance for every other attack.
export default process.env.SENTRY_DSN
  ? withSentryConfig(nextConfig, {
      silent: true,
      telemetry: false,
      disableLogger: true,
      sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
    })
  : nextConfig;
