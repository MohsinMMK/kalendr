import { z } from "zod";

import { businessTypeIds } from "./business-types";

/** The directory's address words. Each is cleaned, so a made-up value falls back to "no filter" instead of an error page. */
export const exploreQuerySchema = z.object({
  q: z.string().catch("").transform((value) => value.replace(/\s+/g, " ").trim().slice(0, 80)),
  city: z.string().catch("").transform((value) => value.trim().slice(0, 120)),
  type: z.string().catch("").transform((value) => (businessTypeIds.some((id) => id === value) ? value : "")),
  page: z.coerce.number().int().min(1).max(500).catch(1),
});
export type ExploreQuery = z.infer<typeof exploreQuerySchema>;

export function parseExploreQuery(searchParams: Record<string, string | string[] | undefined>): ExploreQuery {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  return exploreQuerySchema.parse({ q: first(searchParams.q), city: first(searchParams.city), type: first(searchParams.type), page: first(searchParams.page) });
}

/** `/explore` with the chosen filters. Empty ones are left out, so the address stays short and shareable. */
export function exploreHref(query: Partial<ExploreQuery>): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.city) params.set("city", query.city);
  if (query.type) params.set("type", query.type);
  if (query.page && query.page > 1) params.set("page", String(query.page));
  const text = params.toString();
  return text ? `/explore?${text}` : "/explore";
}
