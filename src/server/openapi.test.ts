/** @vitest-environment node */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { apiScopes } from "@/lib/api-scopes";
import { buildOpenApiDocument } from "@/server/openapi";
import { apiOperations } from "@/server/openapi-operations";
import { webhookEvents } from "@/server/openapi-webhooks";

const routeRoot = path.resolve(process.cwd(), "src/app/api/v1");

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === "route.ts" ? [full] : [];
  });
}

/** `src/app/api/v1/appointments/[id]/cancel/route.ts` becomes `/api/v1/appointments/{id}/cancel`. */
function pathOf(file: string): string {
  const relative = path.relative(path.resolve(process.cwd(), "src/app"), path.dirname(file));
  return `/${relative.split(path.sep).join("/")}`.replace(/\[(\w+)\]/g, "{$1}");
}

function methodsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/export\s+(?:async\s+function|function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((match) => match[1]!.toLowerCase());
}

describe("the OpenAPI document", () => {
  const document = buildOpenApiDocument();

  it("is OpenAPI 3.1 with bearer auth and the webhook section", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(document.components?.securitySchemes).toHaveProperty("bearerAuth");
    expect(Object.keys(document.webhooks ?? {}).sort()).toEqual(webhookEvents.map((event) => event.type).sort());
    expect(Object.keys(document.webhooks ?? {})).toEqual(expect.arrayContaining(["appointment.created", "payment.captured", "customer.created", "webhook.test"]));
  });

  it("lists every operation with its scope, and writes that create need an Idempotency-Key", () => {
    for (const operation of apiOperations) {
      const entry = document.paths?.[operation.path]?.[operation.method];
      expect(entry, `${operation.method} ${operation.path}`).toBeDefined();
      expect(entry).toMatchObject({ "x-required-scope": operation.scope });
      expect(apiScopes).toContain(operation.scope);
      const parameters = JSON.stringify(entry?.parameters ?? []);
      if (operation.idempotent) expect(parameters).toContain("Idempotency-Key");
      expect(entry?.responses).toHaveProperty("429");
      expect(entry?.responses).toHaveProperty("401");
    }
  });

  it("documents the rate limit headers and Retry-After", () => {
    const text = JSON.stringify(document);
    for (const name of ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After"]) expect(text).toContain(name);
  });

  it("does not leak internal names", () => {
    const text = JSON.stringify(document).toLowerCase();
    for (const word of ["patientid", "practitioner", "clinicslug", "managetoken"]) expect(text).not.toContain(word);
  });
});

describe("routes and the document agree", () => {
  const files = routeFiles(routeRoot).filter((file) => !file.endsWith(path.join("openapi.json", "route.ts")));
  const found = files.flatMap((file) => methodsOf(file).map((method) => `${method} ${pathOf(file)}`)).sort();
  const documented = apiOperations.map((operation) => `${operation.method} ${operation.path}`).sort();

  it("has a spec entry for every route method", () => {
    expect(found.length).toBeGreaterThan(0);
    expect(found).toEqual(documented);
  });

  it("has unique operation ids", () => {
    expect(new Set(apiOperations.map((operation) => operation.id)).size).toBe(apiOperations.length);
  });
});
