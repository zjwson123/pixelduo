import type { MetadataRoute } from "next";
import { siteBase } from "@/lib/site";

// Dynamic ON PURPOSE: the sitemap must carry the origin of the deployment that
// is serving it, and a prerendered one carries whatever NEXTAUTH_URL the build
// environment happened to have — which, for the documented image build, is
// nothing at all, so every <loc> claimed http://localhost:3000. See lib/site.ts.
export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteBase();
  const now = new Date();
  return [
    { url: base, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/login`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/register`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    { url: `${base}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    { url: `${base}/feedback`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];
}
