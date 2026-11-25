import "server-only";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { enforceLimit, routeErrorResponse } from "@/server/http";

import { createMcpServer } from "./server";

/**
 * Serves one MCP request over streamable HTTP, stateless: a fresh server and transport per request, plain JSON
 * answers, no sessions to expire or to hijack. Counted per network before anything else runs.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await enforceLimit(request, "mcp.ip");
    const server = createMcpServer(request.headers);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error: unknown) {
    return routeErrorResponse(error, "mcp", requestId);
  }
}
