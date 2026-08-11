import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PixelDuo — Two models. One prompt. Your call.",
  description:
    "Dual-engine AI image studio: GPT Image 2 × Seedream 5, transparent per-image pricing, AI prompt assistant.",
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
