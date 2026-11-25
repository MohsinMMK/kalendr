import { customerIdSchema, noteUpdateSchema } from "@/lib/customer-contracts";
import { deleteNote, updateNote } from "@/server/customers/notes";
import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; noteId: string }> };

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { id, noteId } = await params;
    return dataResponse(await updateNote(context, customerIdSchema.parse(id), customerIdSchema.parse(noteId), await parseJsonBody(request, noteUpdateSchema)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.notes.update", requestId);
  }
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const { id, noteId } = await params;
    return dataResponse(await deleteNote(context, customerIdSchema.parse(id), customerIdSchema.parse(noteId)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.notes.delete", requestId);
  }
}
