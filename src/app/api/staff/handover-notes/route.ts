import { addHandoverNote, handoverNoteInputSchema, listHandoverNotes } from "@/server/handover-notes";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Handover notes from the last two days. Every staff member can read them. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await listHandoverNotes(context));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.handover.list", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const input = await parseJsonBody(request, handoverNoteInputSchema, { maxBytes: 4_000 });
    return dataResponse(await addHandoverNote(context, input), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.handover.add", requestId);
  }
}
