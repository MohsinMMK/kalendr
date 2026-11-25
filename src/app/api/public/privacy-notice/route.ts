import { z } from "zod";

import { dataResponse, enforceLimit, parseQuery, routeErrorResponse } from "@/server/http";
import { getPublicPrivacyNotice } from "@/server/privacy/notice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  clinic: z.string().trim().min(1).max(80),
  language: z.string().trim().max(10).optional(),
});

/** The privacy notice to show beside the consent choices on a public booking page. Query: clinic=<slug>, language=en|hi. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "privacy_notice.ip");
    const query = parseQuery(request, querySchema);
    return dataResponse(await getPublicPrivacyNotice(query.clinic, query.language));
  } catch (error: unknown) {
    return routeErrorResponse(error, "public.privacy-notice", requestId);
  }
}
