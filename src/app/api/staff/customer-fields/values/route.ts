import { listFieldValuesForGrid } from "@/server/customers/fields";
import { dataResponse, routeErrorResponse } from "@/server/http";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every extra-field answer the signed-in person may see, for the customer table: `{ [customerId]: { [fieldId]: value } }`. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await listFieldValuesForGrid(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.customer.fields.values", requestId);
  }
}
