import { handleMcpRequest } from "@/server/mcp/handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The MCP endpoint (feature 54). Public tools work without a key; staff tools read the API key from the same request. */
export const POST = handleMcpRequest;
export const GET = handleMcpRequest;
export const DELETE = handleMcpRequest;
