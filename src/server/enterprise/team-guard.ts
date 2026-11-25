import "server-only";

import { ApiError } from "@/server/api-error";
import { can, requirePermission, type StaffContext } from "@/server/staff-context";

/** Teams are managed by whoever manages the team or the whole organisation. They need no plan feature and no second-factor check. */
export function guardTeamWrite(context: StaffContext): void {
  requirePermission(context, can(context, "org.manage") ? "org.manage" : "team.manage");
  if (context.preview) throw new ApiError(400, "preview_only", "Team changes are unavailable in preview mode.");
}
