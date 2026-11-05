import type { Metadata } from "next";

// Same as /reset-password: the page reads a single-use verification token from
// the query string and must not be indexed (pass 53).
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function VerifyEmailLayout({ children }: { children: React.ReactNode }) {
  return children;
}
