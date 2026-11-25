import { z } from "zod";

import { buildOpenApiDocument } from "@/server/openapi";

/**
 * Turns the generated OpenAPI document into the rows the /developers page shows. The page lists whatever the document
 * holds, so a new operation appears there without anyone touching the page. The document is read through a small
 * schema (rather than cast) so a change in its shape fails loudly here instead of rendering nonsense.
 */

export interface SchemaNode {
  type?: string | string[];
  format?: string;
  description?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  anyOf?: SchemaNode[];
  $ref?: string;
  minimum?: number;
  maximum?: number;
  default?: unknown;
}

const schemaNode: z.ZodType<SchemaNode> = z.lazy(() => z.object({
  type: z.union([z.string(), z.array(z.string())]).optional(),
  format: z.string().optional(),
  description: z.string().optional(),
  enum: z.array(z.unknown()).optional(),
  const: z.unknown().optional(),
  properties: z.record(z.string(), schemaNode).optional(),
  required: z.array(z.string()).optional(),
  items: schemaNode.optional(),
  anyOf: z.array(schemaNode).optional(),
  $ref: z.string().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  default: z.unknown().optional(),
}).loose());

const parameterNode = z.object({
  in: z.enum(["query", "path", "header", "cookie"]),
  name: z.string(),
  required: z.boolean().optional(),
  description: z.string().optional(),
  schema: schemaNode.optional(),
});

const bodyNode = z.object({ content: z.record(z.string(), z.object({ schema: schemaNode, example: z.unknown().optional() })) });

const operationNode = z.object({
  operationId: z.string(),
  summary: z.string(),
  description: z.string(),
  "x-required-scope": z.string(),
  parameters: z.array(parameterNode).optional(),
  requestBody: bodyNode.extend({ required: z.boolean().optional() }).optional(),
  responses: z.record(z.string(), z.object({ description: z.string(), content: bodyNode.shape.content.optional() })),
});

const documentNode = z.object({
  paths: z.record(z.string(), z.record(z.string(), operationNode)),
  components: z.object({ schemas: z.record(z.string(), schemaNode) }),
});

export interface Row {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface ResponseDoc {
  status: string;
  description: string;
  rows: Row[];
  example: unknown;
}

export interface OperationDoc {
  id: string;
  anchor: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  scope: string;
  parameters: Array<Row & { location: string }>;
  body: { rows: Row[]; example: unknown; required: boolean } | null;
  responses: ResponseDoc[];
}

export function loadReference(): OperationDoc[] {
  const document = documentNode.parse(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  const schemas = document.components.schemas;
  const resolve = (node: SchemaNode): SchemaNode => {
    if (!node.$ref) return node;
    const target = schemas[node.$ref.split("/").pop() ?? ""];
    return target ? { ...target, ...(node.description ? { description: node.description } : {}) } : node;
  };

  const typeOf = (raw: SchemaNode): string => {
    const node = resolve(raw);
    if (node.anyOf) return node.anyOf.map(typeOf).join(" or ");
    if (node.enum) return node.enum.map((value) => JSON.stringify(value)).join(" | ");
    if (node.const !== undefined) return JSON.stringify(node.const);
    const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
    const label = types.map((type) => (type === "array" ? `array of ${node.items ? typeOf(node.items) : "any"}` : type === "object" ? "object" : type)).join(" or ");
    // The format says more than "string" does; the long pattern zod adds for dates is never shown.
    return node.format && !node.enum ? `${label} (${node.format})` : label || "any";
  };

  const rowsOf = (raw: SchemaNode, prefix = "", depth = 0): Row[] => {
    const node = resolve(raw);
    if (node.type === "array" && node.items) return rowsOf(node.items, `${prefix}[]`, depth);
    if (!node.properties || depth > 3) return [];
    const required = new Set(node.required ?? []);
    return Object.entries(node.properties).flatMap(([name, child]) => {
      const path = prefix ? `${prefix}.${name}` : name;
      const resolved = resolve(child);
      const own: Row = { name: path, type: typeOf(child), required: required.has(name), description: resolved.description ?? "" };
      const isObject = resolved.type === "object" && resolved.properties;
      const isObjectList = resolved.type === "array" && resolved.items && resolve(resolved.items).properties;
      return [own, ...(isObject || isObjectList ? rowsOf(resolved, path, depth + 1) : [])];
    });
  };

  return Object.entries(document.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, operation]) => {
    const json = (content: z.infer<typeof bodyNode>["content"] | undefined) => content?.["application/json"];
    const body = json(operation.requestBody?.content);
    return {
      id: operation.operationId,
      anchor: `op-${operation.operationId}`,
      method: method.toUpperCase(),
      path,
      summary: operation.summary,
      description: operation.description,
      scope: operation["x-required-scope"],
      parameters: (operation.parameters ?? []).map((parameter) => ({
        name: parameter.name,
        location: parameter.in,
        type: parameter.schema ? typeOf(parameter.schema) : "string",
        required: parameter.required === true,
        description: parameter.description ?? (parameter.schema ? resolve(parameter.schema).description ?? "" : ""),
      })),
      body: body ? { rows: rowsOf(body.schema), example: body.example, required: operation.requestBody?.required === true } : null,
      responses: Object.entries(operation.responses).map(([status, response]) => {
        const content = json(response.content);
        return { status, description: response.description, rows: content && status.startsWith("2") ? rowsOf(content.schema) : [], example: content?.example };
      }),
    };
  }));
}
