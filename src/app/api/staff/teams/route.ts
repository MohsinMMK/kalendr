import { dataResponse, parseJsonBody, routeErrorResponse } from "@/server/http";
import { assertNotReadOnlyImpersonation, getStaffContext } from "@/server/staff-context";
import { teamInputSchema } from "@/lib/enterprise-contracts";
import { createTeam, listTeams } from "@/server/enterprise/teams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    return dataResponse(await listTeams(context), 200);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.teams.list", requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const context = await getStaffContext(request.headers);
    assertNotReadOnlyImpersonation(context);
    return dataResponse(await createTeam(context, await parseJsonBody(request, teamInputSchema)), 201);
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.teams.create", requestId);
  }
}
