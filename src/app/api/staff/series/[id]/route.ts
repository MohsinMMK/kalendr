import { ApiError } from "@/server/api-error";
import { dataResponse, getIdempotencyKey, parseJsonBody, routeErrorResponse } from "@/server/http";
import { getSeriesView } from "@/server/series";
import { changeSeries, previewSeriesChange } from "@/server/series-change";
import { seriesChangePreviewSchema, seriesChangeSchema } from "@/server/series-contracts";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

async function seriesId(params: Params["params"]): Promise<string> {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new ApiError(404, "series_not_found", "That repeating series was not found.");
  return id;
}

/** The series with every visit and its status. */
export async function GET(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await getSeriesView(context, await seriesId(params)));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.series.get", requestId);
  }
}

/** What "this and following" or "all" would book if changed as asked, every visit checked. Saves nothing. */
export async function POST(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const body = await parseJsonBody(request, seriesChangePreviewSchema);
    return dataResponse(await previewSeriesChange(context, await seriesId(params), body));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.series.change_preview", requestId);
  }
}

/** Changes or cancels "this and following" or "all" visits of a series. The series version must be the one the screen loaded. */
export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const idempotencyKey = getIdempotencyKey(request);
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    const body = await parseJsonBody(request, seriesChangeSchema);
    const result = await changeSeries(context, await seriesId(params), body, idempotencyKey);
    return dataResponse(result, result.changed ? 200 : 409);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.series.change", requestId);
  }
}
