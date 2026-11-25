import type { MetadataRoute } from "next";

import { marketingPages } from "@/features/marketing/site-nav";
import { publicAppUrl } from "@/server/env";
import { sitemapFileCount } from "@/server/discovery";

// Names every sitemap file, so it follows the number of listed businesses.
export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const appUrl = publicAppUrl();
  const files = await sitemapFileCount().catch(() => 1);

  return {
    rules: {
      userAgent: "*",
      // /book/ stays crawlable on purpose: a crawler has to fetch a booking step to read its `noindex`.
      allow: ["/", ...marketingPages.map((page) => page.href), "/developers", "/b/", "/book/", "/explore"],
      disallow: [
        "/access-denied",
        "/api/",
        "/appointments",
        "/billing",
        "/bookings",
        "/check-in/",
        "/dashboard",
        "/doctors",
        "/embed-demo",
        "/follow-ups",
        "/classes",
        "/class/",
        "/forgot-password",
        "/l/",
        "/manage/",
        "/m/",
        "/messages",
        "/offer/",
        "/offers",
        "/patients",
        "/pay/",
        "/portal",
        "/print/",
        "/profile",
        "/q/",
        "/r/",
        "/records",
        "/reset-password",
        "/s/",
        "/schedule",
        "/settings",
        "/setup",
        "/sign-in",
        "/start",
        "/unsubscribed",
        "/visit/",
      ],
    },
    sitemap: Array.from({ length: files }, (_, id) => `${appUrl}/sitemap/${id}.xml`),
  };
}
