import { buildOpenApiDocument } from "@/server/openapi";

export const runtime = "nodejs";

/** Public on purpose: the document describes the API and holds nothing about any business. */
export function GET(): Response {
  return Response.json(buildOpenApiDocument(), {
    headers: { "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" },
  });
}
