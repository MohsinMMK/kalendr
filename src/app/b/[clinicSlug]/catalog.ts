import "server-only";

import { cache } from "react";

import { getPublicClinicCatalog } from "@/server/public-catalog";

/** One catalog read per render, shared by the page and its metadata. Availability stays live. */
export const getBusinessCatalog = cache((slug: string) => getPublicClinicCatalog(slug));
