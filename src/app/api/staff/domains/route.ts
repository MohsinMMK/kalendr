import { z } from "zod";

import { hostnameInputSchema } from "@/lib/domain-rules";
import { addDomain, listDomains } from "@/server/domains/service";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The business's own web addresses and where each one stands. The screen polls this while it waits for a check. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await listDomains(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.domains.list", requestId);
  }
}

/** Adds an address and returns the two DNS records to publish. The TXT value is shown only in this answer. Needs a plan with own web address. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const input = await parseJsonBody(request, z.strictObject(hostnameInputSchema.shape));
    return dataResponse(await addDomain(context, input.hostname), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.domains.add", requestId);
  }
}
