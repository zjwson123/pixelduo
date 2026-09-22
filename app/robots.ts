import type { MetadataRoute } from "next";
import { siteBase } from "@/lib/site";

// Dynamic ON PURPOSE, like app/sitemap.ts: the Sitemap line must name the
// origin actually serving this file, not the one the build environment had.
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const base = siteBase();
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/studio", "/account/", "/verify-email", "/reset-password"],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
