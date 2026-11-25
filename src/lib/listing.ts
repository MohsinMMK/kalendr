import { z } from "zod";

import { seoSettingsSchema, type SeoSettings } from "./seo";
import type { ShareLink } from "./share-kit";

/** What the owner chose. `expected` is what the screen last saw, so a change made elsewhere in the meantime is not overwritten silently. */
export const listingUpdateSchema = z.object({
  listed: z.boolean(),
  seo: seoSettingsSchema,
  expected: z.object({ listed: z.boolean(), seo: seoSettingsSchema }),
});
export type ListingUpdate = z.infer<typeof listingUpdateSchema>;

export interface ListingView {
  listed: boolean;
  seo: SeoSettings;
  /** Whether search engines may list the pages right now: switched on, and the business is running. */
  indexable: boolean;
  /** Plain-words reasons a listed business is still hidden from search engines. */
  blockers: string[];
  businessName: string;
  city: string | null;
  /** The business page's canonical address and the title and description search results will show. */
  pageUrl: string;
  defaultTitle: string;
  defaultDescription: string;
  links: ShareLink[];
  emailSignature: string;
  /** The poster's colour and name come from Brand settings. */
  preview: boolean;
}
