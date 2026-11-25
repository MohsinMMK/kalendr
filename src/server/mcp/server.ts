import "server-only";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ApiScope } from "@/lib/api-scopes";
import { ApiError } from "@/server/api-error";
import { getApiKeyContext, type ApiKeyContext } from "@/server/api-key-context";
import { loadEntitlements, requireFeature } from "@/server/entitlements";
import { rateLimitRules } from "@/server/rate-limit-rules";
import { clientAddress, hitRateLimit, recordRefusal } from "@/server/rate-limit";

import {
  findOpenTimesTool, findTimesInput, listPeopleInput, listPeopleTool, listServicesInput, listServicesTool, startBookingInput, startBookingTool,
} from "./public-tools";
import { logToolCall, toolData, toolError } from "./results";
import {
  addNoteInput, addNoteTool, cancelInput, cancelTool, rescheduleInput, rescheduleTool, todaysBookingsInput, todaysBookingsTool,
} from "./staff-tools";

/**
 * The Kalendr MCP server (feature 54). One is built per request, because the transport is stateless: it holds the
 * request's headers so a staff tool can read the caller's API key, and nothing else.
 */

export const SERVER_INFO = { name: "kalendr", version: "1.0.0" } as const;

export const publicToolNames = ["list_services", "list_people", "find_open_times", "start_booking"] as const;
export const staffToolNames = ["list_todays_bookings", "reschedule_booking", "cancel_booking", "add_booking_note"] as const;

const instructions = [
  "Kalendr books appointments. Use `business` (the link name from the booking page address) with the public tools.",
  "start_booking only holds a time and returns a link: tell the customer to open it and confirm.",
  "Staff tools need an API key sent as `Authorization: Bearer <key>` and the scope noted in each tool's description.",
].join(" ");

export function createMcpServer(headers: Headers): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions });

  const publicTool = <T,>(name: string, run: (input: T) => Promise<unknown>) => async (input: T): Promise<CallToolResult> => {
    try {
      const data = await run(input);
      logToolCall(name, null, "ok");
      return toolData(data);
    } catch (error: unknown) {
      logToolCall(name, null, error instanceof ApiError ? "refused" : "error");
      return toolError(error);
    }
  };

  const staffTool = <T,>(name: string, scope: ApiScope, run: (context: ApiKeyContext, input: T) => Promise<unknown>) => async (input: T): Promise<CallToolResult> => {
    let tenantId: string | null = null;
    try {
      const context = await getApiKeyContext(headers, scope);
      tenantId = context.tenantId;
      // The staff tools come with the plan's API, like the keys themselves (the public tools stay open to every business).
      requireFeature({ entitlements: (await loadEntitlements(context.tenantId)).entitlements }, "api");
      const data = await run(context, input);
      logToolCall(name, tenantId, "ok");
      return toolData(data);
    } catch (error: unknown) {
      logToolCall(name, tenantId, error instanceof ApiError ? "refused" : "error");
      return toolError(error);
    }
  };

  server.registerTool("list_services", {
    description: "List the services a business offers, with length and price.",
    inputSchema: listServicesInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, publicTool("list_services", listServicesTool));

  server.registerTool("list_people", {
    description: "List the people (practitioners, stylists, staff) who take bookings, optionally for one service.",
    inputSchema: listPeopleInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, publicTool("list_people", listPeopleTool));

  server.registerTool("find_open_times", {
    description: "Find open appointment times for a service in a date window of up to 14 days.",
    inputSchema: findTimesInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, publicTool("find_open_times", findOpenTimesTool));

  server.registerTool("start_booking", {
    description: "Hold an open time for 5 minutes and return a link the customer opens to enter their details and confirm. It never completes a booking by itself.",
    inputSchema: startBookingInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, publicTool("start_booking", async (input: Parameters<typeof startBookingTool>[0]) => {
    const result = await hitRateLimit("mcp.start_booking.ip", clientAddress(headers));
    if (!result.allowed) {
      recordRefusal("mcp.start_booking.ip");
      throw new ApiError(429, "rate_limited", rateLimitRules["mcp.start_booking.ip"].message);
    }
    return startBookingTool(input);
  }));

  server.registerTool("list_todays_bookings", {
    description: "Staff: list today's bookings for the business. Needs an API key with the appointments:read scope.",
    inputSchema: todaysBookingsInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, staffTool("list_todays_bookings", "appointments:read", (context: ApiKeyContext) => todaysBookingsTool(context)));

  server.registerTool("reschedule_booking", {
    description: "Staff: move a booking to another open time. Needs an API key with the appointments:write scope.",
    inputSchema: rescheduleInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, staffTool("reschedule_booking", "appointments:write", rescheduleTool));

  server.registerTool("cancel_booking", {
    description: "Staff: cancel a booking. Needs an API key with the appointments:write scope.",
    inputSchema: cancelInput,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, staffTool("cancel_booking", "appointments:write", cancelTool));

  server.registerTool("add_booking_note", {
    description: "Staff: set the note on a booking. Needs an API key with the appointments:write scope.",
    inputSchema: addNoteInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, staffTool("add_booking_note", "appointments:write", addNoteTool));

  return server;
}
