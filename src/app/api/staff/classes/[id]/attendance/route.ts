import { attendanceSchema } from "@/lib/classes-contracts";
import { markAttendance } from "@/server/classes";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Marks one person present or absent. Version-checked on the person's place. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await markAttendance(context, (await params).id, await parseJsonBody(request, attendanceSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.classes.attendance", requestId);
  }
}
