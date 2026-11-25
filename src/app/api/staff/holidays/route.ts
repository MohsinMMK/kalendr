import { holidaySettingsUpdateSchema } from "@/lib/availability-setup";
import { getHolidayListing, saveHolidaySettings } from "@/server/availability-extras";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The next 12 months of public holidays for the chosen country, each with whether the business is closed. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await getHolidayListing(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.holidays.read", requestId);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await saveHolidaySettings(context, await parseJsonBody(request, holidaySettingsUpdateSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.holidays.save", requestId);
  }
}
