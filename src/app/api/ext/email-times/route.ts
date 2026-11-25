import { oneResult, v1Route } from "@/server/api-v1";
import { extensionEmailTimes, extensionEmailTimesQuery } from "@/server/extension-api";
import { parseQuery } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = v1Route("ext.email_times", "services:read", async ({ request, context }) => {
  const { serviceId } = parseQuery(request, extensionEmailTimesQuery);
  return oneResult(await extensionEmailTimes(context, serviceId));
});
