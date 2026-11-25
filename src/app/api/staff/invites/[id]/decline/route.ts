import { dataResponse, routeErrorResponse } from "@/server/http";
import { requireSessionUserId } from "@/server/staff-businesses";
import { declineLoginInvite } from "@/server/staff-login-invites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed-in person declines a business's invite to their own login. The business is not told; it still sees "invited". */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const userId = await requireSessionUserId(request.headers);
    const { id } = await params;
    return dataResponse(await declineLoginInvite(userId, id));
  } catch (error: unknown) {
    return routeErrorResponse(error, "staff.invite.decline", requestId);
  }
}
