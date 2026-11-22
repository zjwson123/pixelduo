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
  if (!raw) return "http://localhost:3000";
  // An ORIGIN, not the raw string (pass 67). NEXTAUTH_URL is documented as the
  // deployment's origin, but nothing stopped an operator pasting the shape they
  // use for DATABASE_URL/SMTP_URL — `https://user:secret@host` — and every
  // ABSOLUTE producer here published it verbatim: sitemap.xml, robots.txt's
  // Sitemap line, the og: tags, and every link in every mail. `new URL().origin`
  // drops userinfo, path, query and fragment, which are all invalid for this
  // value anyway (next-auth builds callback URLs by appending to it). A value
  // that does not parse keeps the old trailing-slash trim; the production boot
  // gate refuses it separately.
  try {
    return new URL(raw).origin;
  } catch {
    // Trailing slashes would produce "https://host//sitemap.xml".
    return raw.replace(/\/+$/, "");
  }
}
