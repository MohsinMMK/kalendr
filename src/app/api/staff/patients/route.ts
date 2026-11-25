import { profileWords } from "@/lib/terminology";
import { ApiError } from "@/server/api-error";
import { staffPatientSearchSchema } from "@/server/contracts";
import { getStaffContext, requirePermission } from "@/server/staff-context";
import { createStaffPatient, staffPatientCreateInput } from "@/server/staff-operations";
import { searchStaffPatients } from "@/server/staff-repository";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { applyFeatureLimits, loadStaffBusinessProfile } from "@/server/business-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    const parsed = staffPatientSearchSchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    if (!parsed.success) {
      throw new ApiError(400, "validation_error", `The ${profileWords(await loadStaffBusinessProfile(context)).customer} search is invalid.`);
    }
    return dataResponse(await searchStaffPatients(context, parsed.data.q, parsed.data.limit));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.patient.search", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    requirePermission(context, "appointments.book");
    const input = applyFeatureLimits(await parseJsonBody(request, staffPatientCreateInput), await loadStaffBusinessProfile(context));
    return dataResponse(await createStaffPatient(context, input), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.patient.create", requestId);
  }
}
