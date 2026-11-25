import { z } from "zod";

import { serviceTaxRuleInputSchema } from "@/lib/invoicing-contracts";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { saveServiceTaxRule } from "@/server/invoicing/settings";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const clearSchema = z.strictObject({ serviceId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/) });

/** Sets one service's own tax treatment. */
export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    return dataResponse(await saveServiceTaxRule(staff, await parseJsonBody(request, serviceTaxRuleInputSchema, { maxBytes: 1_000 })));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.tax_settings.service", requestId);
  }
}

/** Puts a service back on the business default. */
export async function DELETE(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const input = await parseJsonBody(request, clearSchema, { maxBytes: 500 });
    return dataResponse(await saveServiceTaxRule(staff, { serviceId: input.serviceId, clear: true }));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.tax_settings.service_clear", requestId);
  }
}
