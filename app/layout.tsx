import type { Metadata } from "next";
import { siteBase } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  // Read at BUILD time (this metadata is baked into prerendered HTML), so the
  // image build must carry NEXTAUTH_URL — the Dockerfile takes it as a build ARG
  // and the composes pass it from `.env`. Without it every page's og:url and
  // og:image pointed at http://localhost:3000. See lib/site.ts.
  metadataBase: new URL(siteBase()),
  title: "PixelDuo — Two models. One prompt. Your call.",
  description:
    "Dual-engine AI image studio: GPT Image 2 × Seedream 5, transparent per-image pricing, AI prompt assistant.",
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/",
    siteName: "PixelDuo",
    title: "PixelDuo — Two models. One prompt. Your call.",
    description:
      "Dual-engine AI image studio: GPT Image 2 × Seedream 5, transparent per-image pricing, AI prompt assistant.",
    images: [{ url: "/templates/cyber_2560.png", width: 2560, height: 2560, alt: "PixelDuo dual-engine AI image studio" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "PixelDuo — Two models. One prompt. Your call.",
    description: "Dual-engine AI image studio: GPT Image 2 × Seedream 5 with transparent per-image pricing.",
    images: ["/templates/cyber_2560.png"],
  },
  robots: { index: true, follow: true },
};

const themeScript = `
try {
  const t = localStorage.getItem("pd-theme");
  if (t === "dark") document.documentElement.setAttribute("data-theme", "dark");
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link
          rel="icon"
          href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><rect x='2' y='2' width='14' height='14' rx='3' fill='%234338F7'/><rect x='8' y='8' width='14' height='14' rx='3' fill='%23F4511E' opacity='0.9'/></svg>"
        />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
