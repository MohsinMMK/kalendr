import { devicePollRequest, tokenRequest } from "@/lib/oauth";
import { pollDeviceFlow } from "@/server/oauth/device";
import { OAuthError, oauthErrorResponse } from "@/server/oauth/errors";
import { exchangeToken } from "@/server/oauth/token-endpoint";
import { reportServerError } from "@/server/error-reporting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maxBody = 4_000;

/** OAuth clients send form fields; JSON is accepted too. */
async function readFields(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > maxBody) throw new OAuthError("invalid_request", "The request is too large.");
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
    } catch {
      throw new OAuthError("invalid_request", "The request body is not valid JSON.");
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const fields = await readFields(request);
    const grantType = fields.grant_type;
    if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
      const poll = devicePollRequest.safeParse(fields);
      if (!poll.success) throw new OAuthError("invalid_request", "A required field is missing or malformed.");
      return Response.json(await pollDeviceFlow(poll.data, request.headers), { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } });
    }
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      throw new OAuthError("unsupported_grant_type", "Use authorization_code, refresh_token or the device code grant.");
    }
    const parsed = tokenRequest.safeParse(fields);
    if (!parsed.success) throw new OAuthError("invalid_request", "A required field is missing or malformed.");
    const token = await exchangeToken(parsed.data, request.headers);
    return Response.json(token, { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } });
  } catch (error: unknown) {
    if (error instanceof OAuthError) return oauthErrorResponse(error);
    reportServerError(error, { requestId, route: "oauth.token" });
    return Response.json({ error: "server_error", error_description: "The request could not be completed." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
