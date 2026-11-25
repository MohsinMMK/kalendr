import { creditNoteInputSchema } from "@/lib/invoicing-contracts";
import { ApiError } from "@/server/api-error";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { issueCreditNote } from "@/server/invoicing/invoice";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Corrects an issued invoice by taking whole lines back. The money is refunded separately. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const staff = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(staff);
    const id = (await context.params).id;
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new ApiError(404, "invoice_not_found", "That invoice could not be found.");
    const idempotencyKey = getIdempotencyKey(request);
    const input = await parseJsonBody(request, creditNoteInputSchema, { maxBytes: 4_000 });
    return dataResponse(await issueCreditNote(staff, id, input, idempotencyKey), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.invoices.credit", requestId);
  }
}
