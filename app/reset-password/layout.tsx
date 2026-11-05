import type { Metadata } from "next";

// The page reads a single-use reset credential from the query string. The root
// layout marks every page `index, follow`; robots.txt disallows this path, but
// engines can still record a disallowed URL — token and all — when it is linked
// from somewhere crawlable. Say noindex at the page instead of inheriting the
// site-wide default (pass 53).
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
