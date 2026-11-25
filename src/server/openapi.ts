import { createDocument } from "zod-openapi";
import { z } from "zod";

import { apiScopeLabels } from "@/lib/api-scopes";
import { errorSchema } from "@/server/api-v1-contracts";
import { apiOperations, sharedErrors, type ApiOperation } from "@/server/openapi-operations";
import { webhookEvents, webhookHeaders } from "@/server/openapi-webhooks";

/**
 * Builds the OpenAPI 3.1 document for /api/v1 from the operation list. It is served at /api/v1/openapi.json and
 * the /developers page renders from the same list, so the two always agree.
 */

const rateHeaders: Record<string, { description: string; schema: { type: "integer" } }> = {
  "X-RateLimit-Limit": { description: "Requests allowed per minute for this key.", schema: { type: "integer" } },
  "X-RateLimit-Remaining": { description: "Requests left in this minute.", schema: { type: "integer" } },
  "X-RateLimit-Reset": { description: "Unix time when the minute ends.", schema: { type: "integer" } },
};

interface ResponseDoc {
  description: string;
  headers: Record<string, { description: string; schema: { type: "integer" } }>;
  content: { "application/json": { schema: z.ZodType; example?: unknown } };
}

function errorResponse(description: string, extraHeaders: ResponseDoc["headers"] = {}): ResponseDoc {
  return { description, headers: { ...rateHeaders, ...extraHeaders }, content: { "application/json": { schema: errorSchema } } };
}

function operationObject(operation: ApiOperation) {
  const idempotencyHeader = operation.idempotent
    ? z.object({
      "Idempotency-Key": z.string().min(8).max(160).meta({
        description: "A unique value you choose (8 to 160 of letters, digits, `.`, `_`, `:`, `-`) so a retry never repeats the call.",
        example: "book-2026-12-01-asha",
      }),
    })
    : undefined;
  const responses: Record<string, ResponseDoc> = {
    [String(operation.success.status)]: {
      description: operation.success.description,
      headers: rateHeaders,
      content: { "application/json": { schema: operation.success.schema, example: operation.responseExample } },
    },
  };
  const extra = [...operation.errors, ...sharedErrors.filter((error) => !operation.errors.some((own) => own.status === error.status))];
  for (const error of extra) {
    const key = String(error.status);
    responses[key] = errorResponse(responses[key] ? `${responses[key].description} ${error.code}: ${error.description}` : `${error.code}: ${error.description}`);
  }
  responses["429"] = errorResponse("rate_limited: More than 600 requests in a minute for this key.", { "Retry-After": { description: "Seconds to wait before trying again.", schema: { type: "integer" } } });
  return {
    operationId: operation.id,
    summary: operation.summary,
    description: `${operation.description}\n\nRequires the \`${operation.scope}\` scope.`,
    tags: [operation.path.split("/")[3] ?? "api"],
    security: [{ bearerAuth: [] }],
    "x-required-scope": operation.scope,
    requestParams: {
      ...(operation.pathParam ? { path: z.object({ [operation.pathParam.name]: z.string().meta({ description: operation.pathParam.description }) }) } : {}),
      ...(operation.query ? { query: operation.query } : {}),
      ...(idempotencyHeader ? { header: idempotencyHeader } : {}),
    },
    ...(operation.body ? {
      requestBody: {
        required: operation.id !== "cancelAppointment",
        content: { "application/json": { schema: operation.body, ...(operation.requestExample ? { example: operation.requestExample } : {}) } },
      },
    } : {}),
    responses,
  };
}

export function buildOpenApiDocument() {
  const paths: Record<string, Record<string, ReturnType<typeof operationObject>>> = {};
  for (const operation of apiOperations) {
    paths[operation.path] = { ...paths[operation.path], [operation.method]: operationObject(operation) };
  }
  return createDocument({
    openapi: "3.1.0",
    info: {
      title: "Kalendr API",
      version: "1.0.0",
      description: "Book and manage appointments from your own software. Authenticate with `Authorization: Bearer <key>`. Every list is `{ data, nextCursor, hasMore }`; every error is `{ error: { code, message, fieldErrors? } }`.",
    },
    servers: [{ url: "/", description: "This site" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: `An API key from Settings, like \`kal_live_...\`. Scopes: ${Object.entries(apiScopeLabels).map(([scope, label]) => `\`${scope}\` (${label.description})`).join(" ")}`,
        },
      },
    },
    "x-webhooks-note": "Webhooks are described under `webhooks` for reference. They are sent to your address; you do not call them.",
    webhooks: Object.fromEntries(webhookEvents.map((event) => [event.type, {
      post: {
        summary: event.type,
        description: `${event.description}\n\nHeaders: ${webhookHeaders.map((header) => `\`${header.name}\``).join(", ")}. Verify \`X-Kalendr-Signature\` before trusting the body.`,
        requestBody: { content: { "application/json": { schema: event.schema, example: event.example } } },
        responses: { "200": { description: "Answer with any 2xx within 10 seconds to acknowledge the delivery." } },
      },
    }])),
  });
}

export type OpenApiDocument = ReturnType<typeof buildOpenApiDocument>;
