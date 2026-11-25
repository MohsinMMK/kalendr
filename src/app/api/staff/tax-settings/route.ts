import { taxSettingsInputSchema } from "@/lib/invoicing-contracts";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { getTaxSettings, saveTaxSettings } from "@/server/invoicing/settings";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getTaxSettings(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.tax_settings.get", requestId);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    return dataResponse(await saveTaxSettings(staff, await parseJsonBody(request, taxSettingsInputSchema, { maxBytes: 4_000 })));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.tax_settings.save", requestId);
  }
}
