import { z } from "zod";

import { dataResponse, enforceLimit, parseQuery, routeErrorResponse } from "@/server/http";
import { businessSchema, publicCatalogSummary } from "@/server/mcp/public-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const catalogQuery = z.object({ clinicSlug: businessSchema });

/** The services, people and places a website component needs to offer booking (feature 54). No customer data. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "availability.ip");
    const { clinicSlug } = parseQuery(request, catalogQuery);
    return dataResponse(await publicCatalogSummary(clinicSlug));
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.catalog", requestId);
  }
}
