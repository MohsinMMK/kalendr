import { adminMeSchema } from "@/lib/admin-contracts";
import { roleCan } from "@/lib/admin-access";
import { getAdminContext } from "@/server/admin-context";
import { dataResponse, routeErrorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who is signed in to the console and what their role allows, so the screens can hide what would be refused. */
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const admin = await getAdminContext(request.headers);
    return dataResponse(adminMeSchema.parse({
      userId: admin.userId,
      role: admin.role,
      capabilities: {
        findMessages: roleCan(admin.role, "findMessages"), operate: roleCan(admin.role, "operate"), impersonate: roleCan(admin.role, "impersonate"),
        impersonateWrite: roleCan(admin.role, "impersonateWrite"), manageRollouts: roleCan(admin.role, "manageRollouts"), manageOperators: roleCan(admin.role, "manageOperators"),
      },
    }));
  } catch (error: unknown) {
    return routeErrorResponse(error, "admin.me", requestId);
  }
}
