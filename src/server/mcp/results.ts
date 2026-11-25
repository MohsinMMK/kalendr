import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { ApiError } from "@/server/api-error";
import { errorSummary, logger } from "@/server/logger";

/** Tool answers: one JSON text block, so any client can read them. Errors say what to do next and never carry internals. */
export function toolData(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { result: data } };
}

export function toolError(error: unknown): CallToolResult {
  if (error instanceof ApiError) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ code: error.code, message: error.message }) }] };
  }
  logger().error({ event: "mcp.tool_failed", ...errorSummary(error) }, "An MCP tool failed");
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ code: "internal_error", message: "The request could not be completed." }) }] };
}

/** One log line per call: tool, business and outcome. Arguments carry names and times, so they are never logged. */
export function logToolCall(tool: string, tenantId: string | null, outcome: "ok" | "refused" | "error"): void {
  logger().info({ event: "mcp.tool", tool, tenantId, outcome }, "MCP tool call");
}
