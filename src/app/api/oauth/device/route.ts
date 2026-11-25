import { deviceStartRequest } from "@/lib/oauth";
import { reportServerError } from "@/server/error-reporting";
import { startDeviceFlow } from "@/server/oauth/device";
import { OAuthError, oauthErrorResponse } from "@/server/oauth/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 8628, step one: a device asks for a code to show the person. */
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const text = (await request.text()).slice(0, 4_000);
    const fields = request.headers.get("content-type")?.includes("application/json") ? JSON.parse(text || "{}") as unknown : Object.fromEntries(new URLSearchParams(text));
    const parsed = deviceStartRequest.safeParse(fields);
    if (!parsed.success) throw new OAuthError("invalid_request", "A required field is missing or malformed.");
    return Response.json(await startDeviceFlow(parsed.data, request.headers), { headers: { "Cache-Control": "no-store" } });
  } catch (error: unknown) {
    if (error instanceof OAuthError) return oauthErrorResponse(error);
    if (error instanceof SyntaxError) return oauthErrorResponse(new OAuthError("invalid_request", "The request body is not valid JSON."));
    reportServerError(error, { requestId, route: "oauth.device.start" });
    return Response.json({ error: "server_error", error_description: "The request could not be completed." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
