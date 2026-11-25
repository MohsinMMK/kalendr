/**
 * OAuth errors use the shape RFC 6749 asks of the token endpoint: a fixed `error` word and a plain sentence. They are
 * kept apart from ApiError so a client library that reads `error` finds it where it expects.
 */
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_scope"
  | "unsupported_grant_type"
  | "access_denied"
  | "rate_limited"
  // RFC 8628: what a device is told while it waits.
  | "authorization_pending"
  | "slow_down"
  | "expired_token";

export class OAuthError extends Error {
  constructor(readonly code: OAuthErrorCode, message: string, readonly status: number = 400, readonly headers: Record<string, string> = {}) {
    super(message);
    this.name = "OAuthError";
  }
}

export function oauthErrorResponse(error: OAuthError): Response {
  return Response.json({ error: error.code, error_description: error.message }, {
    status: error.status,
    headers: { "Cache-Control": "no-store", Pragma: "no-cache", ...error.headers },
  });
}
