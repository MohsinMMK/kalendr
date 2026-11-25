import { dataResponse, routeErrorResponse } from "@/server/http";
import { listMismatches } from "@/server/payments/accounts";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the nightly check found that the ledger and the provider disagree on. Open items first. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await listMismatches(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.payment_mismatches.list", requestId);
  }
}
