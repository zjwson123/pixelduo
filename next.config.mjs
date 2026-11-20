import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  // The two token pages must not be reached through Next's internal
  // `/:path+/` → `/:path+` 308 (pass 65). That redirect route is resolved
  // AFTER the headers() rules and its handler returns `resHeaders: null`, so
  // the no-store rule below — whose regex already accepts a trailing slash —
  // was silently discarded for `/reset-password/?token=…`, leaving a
  // heuristically-cacheable 308 whose Location carries a live single-use
  // token. With this flag the page itself answers at the slash URL (the
  // filesystem matcher strips one trailing slash before lookup) and the
  // headers() rule applies. Pinned in e2e/security.spec.ts.
  skipTrailingSlashRedirect: true,
  // Keep the working tree's non-runtime material out of .next/standalone.
  //
  // `next build` copies part of the tree into the standalone output, and on this
  // host that included perf/bench/session.json — a LIVE next-auth session cookie,
  // the perf bench's Playwright storage state, byte-identical to the file on
  // disk — next to raw measurements, docs/, tests/ and backups/. The Dockerfile
  // prunes all of it from the image and .dockerignore keeps it out of the build
  // context, but a host that ships .next/standalone itself (rsync or tar of the
  // standalone output, the usual non-Docker path) carried the cookie along.
  // `.env*` cannot be excluded this way: Next copies environment files into
  // standalone unconditionally, which is why the Dockerfile prunes those too and
  // why scripts/prune-standalone.mjs runs after every build.
  outputFileTracingExcludes: {
    "*": ["perf/**", "docs/**", "tests/**", "e2e/**", "backups/**", "data/**", "public/generated/**"],
  },
  async headers() {
    return [
      {
        // The two pages whose query string IS an account-recovery credential.
        // /reset-password?token=… and /verify-email?token=… are client components
        // reading location.search, and both were prerendered like any other page:
        // `Cache-Control: s-maxage=31536000`, i.e. a live single-use token written
        // into the cache key, the CDN's URI log and every proxy in between, for a
        // year. The body is identical for every token, so nothing about the
        // response needs caching in the first place.
        source: "/:page(reset-password|verify-email)",
        headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0, must-revalidate" }],
      },
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
