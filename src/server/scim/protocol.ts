import "server-only";

import { z } from "zod";

import { ApiError } from "@/server/api-error";

/** SCIM 2.0 wire shapes and helpers (RFC 7643 and 7644) for the company directory (feature 53). */

export const scimUserSchemaId = "urn:ietf:params:scim:schemas:core:2.0:User";
export const scimGroupSchemaId = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const scimListSchemaId = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const scimErrorSchemaId = "urn:ietf:params:scim:api:messages:2.0:Error";
export const scimPatchSchemaId = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export class ScimError extends Error {
  constructor(readonly status: number, readonly detail: string, readonly scimType?: string, readonly retryAfter?: number) {
    super(detail);
    this.name = "ScimError";
  }
}

const contentType = "application/scim+json; charset=utf-8";

export function scimJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": contentType, "cache-control": "no-store", ...headers } });
}

/** Turns anything thrown into the error shape directory tools understand. Internal errors say nothing about what failed. */
export function scimFailure(error: unknown): Response {
  if (error instanceof ScimError) return scimJson({ schemas: [scimErrorSchemaId], status: String(error.status), ...(error.scimType ? { scimType: error.scimType } : {}), detail: error.detail }, error.status, error.retryAfter === undefined ? {} : { "Retry-After": String(error.retryAfter) });
  if (error instanceof ApiError) {
    return scimJson({ schemas: [scimErrorSchemaId], status: String(error.status), detail: error.message }, error.status, error.headers ?? {});
  }
  return scimJson({ schemas: [scimErrorSchemaId], status: "500", detail: "Something went wrong. Try again." }, 500);
}

export async function scimBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(await request.text());
  } catch {
    throw new ScimError(400, "The request body is not valid JSON.", "invalidSyntax");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ScimError(400, parsed.error.issues[0]?.message ?? "The request body is not valid.", "invalidValue");
  return parsed.data;
}

/** A value some directories send as the text "False" or "True" instead of a boolean. */
export const looseBoolean = z.union([z.boolean(), z.string().transform((value, context) => {
  const lowered = value.toLowerCase();
  if (lowered === "true") return true;
  if (lowered === "false") return false;
  context.addIssue({ code: "custom", message: "Expected true or false." });
  return z.NEVER;
})]);

export const patchSchema = z.object({
  schemas: z.array(z.string()).optional(),
  Operations: z.array(z.object({
    op: z.string().transform((value) => value.toLowerCase()).pipe(z.enum(["add", "replace", "remove"])),
    path: z.string().max(200).optional(),
    value: z.unknown().optional(),
  })).min(1).max(100),
});
export type PatchOperation = z.infer<typeof patchSchema>["Operations"][number];

export interface ListQuery {
  startIndex: number;
  count: number;
  filter: { attribute: string; value: string } | null;
}

/** `userName eq "x"` and `externalId eq "x"` are the only filters directories send routinely; any other filter is refused, never ignored. */
export function parseListQuery(url: URL): ListQuery {
  const startIndex = Math.max(1, Number.parseInt(url.searchParams.get("startIndex") ?? "1", 10) || 1);
  const count = Math.min(200, Math.max(0, Number.parseInt(url.searchParams.get("count") ?? "100", 10) || 0));
  const raw = url.searchParams.get("filter");
  if (!raw) return { startIndex, count, filter: null };
  const match = /^\s*(userName|externalId|displayName)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(raw);
  if (!match?.[1] || match[2] === undefined) throw new ScimError(400, "Only filters like userName eq \"name@example.com\" are supported.", "invalidFilter");
  return { startIndex, count, filter: { attribute: match[1].toLowerCase(), value: match[2].replace(/\\(.)/g, "$1") } };
}

export function listResponse(resources: unknown[], total: number, startIndex: number): unknown {
  return { schemas: [scimListSchemaId], totalResults: total, startIndex, itemsPerPage: resources.length, Resources: resources };
}
