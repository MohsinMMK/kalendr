import { dataResponse, routeErrorResponse } from "@/server/http";
import { routingBuilderOptions } from "@/server/routing-forms/forms";
import { getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the builder offers to pick from: services, people, attributes and the booking questions' link names. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return dataResponse(await routingBuilderOptions(await getStaffContext(request.headers)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.routing_forms.options", requestId);
  }
}
