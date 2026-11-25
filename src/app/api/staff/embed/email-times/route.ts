import { emailTimesFor, emailTimesQuerySchema } from "@/server/email-times";
import { dataResponse, parseQuery, routeErrorResponse } from "@/server/http";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The next six open times of a service as email-ready HTML. Read only. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await emailTimesFor(context, parseQuery(request, emailTimesQuerySchema).serviceId));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.embed.email_times", requestId);
  }
}
