import "server-only";

import { z } from "zod";

import type { ApiScope } from "@/lib/api-scopes";
import { ApiError } from "@/server/api-error";
import { getApiKeyContext, rateLimitHeaders, type ApiKeyContext } from "@/server/api-key-context";
import { loadEntitlements, requireFeature } from "@/server/entitlements";
import { reportServerError } from "@/server/error-reporting";
import { errorTenant } from "@/server/request-context";

/**
 * The shared shell of every `/api/v1` route (feature 34): resolve the key, check its scope, count the request
 * against the key's limit, run the work, and answer in the one v1 shape with the standard headers. A route is
 * the schemas plus one function; it never touches headers or errors itself.
 */

export const API_VERSION = "v1";

export interface V1Result {
  status?: number;
  /** A single object, or `{ items, nextCursor }` for a list (use `listResult`). */
  body: unknown;
}

export interface V1Call {
  request: Request;
  context: ApiKeyContext;
  params: Record<string, string>;
}

export type V1RouteContext = { params: Promise<Record<string, string>> };

const baseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Kalendr-Api-Version": API_VERSION };

export function v1Route(
  name: string,
  scope: ApiScope,
  run: (call: V1Call) => Promise<V1Result>,
): (request: Request, routeContext: V1RouteContext) => Promise<Response> {
  return async (request, routeContext) => {
    const requestId = crypto.randomUUID();
    let context: ApiKeyContext | null = null;
    try {
      context = await getApiKeyContext(request.headers, scope);
      // The API comes with the plan: a key made on Growth stops working when the business moves to a plan without it (as MCP does).
      // The browser extension's own routes (ext.*) share this wrapper but are not the API, and stay open on every plan.
      if (!name.startsWith("ext.")) requireFeature({ entitlements: (await loadEntitlements(context.tenantId)).entitlements }, "api");
      const params = await routeContext.params;
      const result = await run({ request, context, params });
      return Response.json(result.body, {
        status: result.status ?? 200,
        headers: { ...baseHeaders, ...rateLimitHeaders(context.rate), "X-Request-Id": requestId },
      });
    } catch (error: unknown) {
      return v1Error(error, name, requestId, context);
    }
  };
}

function v1Error(error: unknown, name: string, requestId: string, context: ApiKeyContext | null): Response {
  const rate = context ? rateLimitHeaders(context.rate) : {};
  if (error instanceof ApiError) {
    return Response.json(
      { error: { code: error.code, message: error.message, ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}) } },
      { status: error.status, headers: { ...baseHeaders, ...rate, ...error.headers, "X-Request-Id": requestId } },
    );
  }
  reportServerError(error, { requestId, route: name, tenantId: errorTenant(error) });
  return Response.json(
    { error: { code: "internal_error", message: "The request could not be completed." } },
    { status: 500, headers: { ...baseHeaders, ...rate, "X-Request-Id": requestId } },
  );
}

export function oneResult<T>(data: T, status = 200): V1Result {
  return { status, body: { data } };
}

export function listResult<T>(items: readonly T[], nextCursor: string | null): V1Result {
  return { body: { data: items, nextCursor, hasMore: nextCursor !== null } };
}

/** Standard paging query: `limit` (1 to 100, default 25) and an opaque `cursor` from the last page. */
export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(400).optional(),
});

const cursorSchema = z.object({ t: z.string().min(1).max(40), id: z.string().min(1).max(160) });
export type PageCursor = z.infer<typeof cursorSchema>;

/** A cursor is the sort key and id of the last row on the page, so paging is stable while rows are added. */
export function encodeCursor(position: PageCursor): string {
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): PageCursor | null {
  if (!cursor) return null;
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through to the same refusal as a cursor that does not parse
  }
  throw new ApiError(400, "invalid_cursor", "The cursor is not valid. Start again without one.", { cursor: ["Use the nextCursor from the previous page."] });
}

/** Takes the fetched rows (one more than the page size) and returns the page plus the cursor for the next one. */
export function pageOf<T>(rows: readonly T[], limit: number, position: (row: T) => PageCursor): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(position(last)) : null };
}
