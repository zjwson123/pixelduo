// The deployment's own origin, for the places that must emit ABSOLUTE urls:
// robots.txt's Sitemap line, every <loc> in sitemap.xml, and the OpenGraph /
// twitter tags' metadataBase.
//
// NEXTAUTH_URL is that origin (production's boot gate already requires it to be
// an https URL, because next-auth derives the session cookie's Secure flag from
// the scheme alone). The trap this helper exists for is WHEN it is read: Next
// prerenders the metadata routes at BUILD time, and the documented image build
// has no NEXTAUTH_URL — .dockerignore excludes `.env*` from the build context,
// and neither the Dockerfile nor the composes passed it as a build arg. So
// `next build` baked `http://localhost:3000` into the shipped artifacts: a
// sitemap whose every entry told crawlers the canonical site is the builder's
// own machine, and og:url/og:image on every page pointing at an origin nobody
// can reach. Nothing failed — the pages served 200 — which is why it survived.
//
// Two defences, because the two halves have different mechanics:
//   - robots.ts and sitemap.ts are marked dynamic, so they read this at REQUEST
//     time and are correct in any deployment, however the image was built.
//   - The static pages' og: tags cannot be (metadataBase is baked into
//     prerendered HTML), so the build must carry NEXTAUTH_URL: the Dockerfile
//     takes it as a build ARG and the composes pass it from `.env`. This helper
//     is the single place both paths read, so they cannot disagree.
export function siteBase(): string {
  const raw = process.env.NEXTAUTH_URL?.trim();
  // Trailing slashes would produce "https://host//sitemap.xml".
  return (raw ? raw : "http://localhost:3000").replace(/\/+$/, "");
}
