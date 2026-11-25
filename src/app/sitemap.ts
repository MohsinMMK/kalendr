import type { MetadataRoute } from "next";

import { marketingPages } from "@/features/marketing/site-nav";
import { canonicalUrl, pagePath } from "@/lib/seo";
import { publicAppUrl } from "@/server/env";
import { sitemapFileCount, sitemapRows } from "@/server/discovery";

// Read when a crawler asks: the listed businesses change as owners switch listing on and off.
export const dynamic = "force-dynamic";

/** One file per 10,000 pages, well under the 50,000 a sitemap may hold. Always at least one. */
// `next build` calls this with no database to reach. Fall back to one file then, as robots.ts does: the route is
// dynamic, so later files still render on request, and robots.ts names them all from the live count.
export async function generateSitemaps(): Promise<{ id: number }[]> {
  const count = await sitemapFileCount().catch(() => 1);
  return Array.from({ length: count }, (_, id) => ({ id }));
}

/**
 * The home page, the product pages, the directory, and every listed, running business with its service and team pages. A business appears
 * only after its owner switches listing on; the list comes from one database function that returns slugs only.
 * Each address is the page's canonical one: the business's own domain when it has a verified one.
 */
export default async function sitemap(props: { id: Promise<string> }): Promise<MetadataRoute.Sitemap> {
  const fileIndex = Math.max(0, Number.parseInt(await props.id, 10) || 0);
  const appUrl = publicAppUrl();
  const rows = await sitemapRows(fileIndex);
  const pages: MetadataRoute.Sitemap = rows.map((row) => ({
    url: canonicalUrl({ appUrl, customHost: row.domain, path: pagePath(row.kind, row.slug, row.key, row.domain !== null) }),
    lastModified: row.updatedAt,
    changeFrequency: row.kind === "business" ? "weekly" : "monthly",
    priority: row.kind === "business" ? 0.8 : 0.6,
  }));
  if (fileIndex > 0) return pages;
  return [
    { url: appUrl, changeFrequency: "monthly", priority: 1 },
    ...marketingPages.map((page) => ({ url: `${appUrl}${page.href}`, changeFrequency: "monthly" as const, priority: 0.9 })),
    { url: `${appUrl}/developers`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${appUrl}/explore`, changeFrequency: "daily", priority: 0.7 },
    ...pages,
  ];
}
