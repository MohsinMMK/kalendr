import { z } from "zod";

import {
  bookingLimitSchema, limitTargetSchema, limitTeamSchema, serviceCustomerRulesSchema,
  type BookingLimitsReplace, type BookingLimitsView, type LimitScope,
} from "@/lib/booking-limits";

/** The booking limits routes. A failure keeps the server's code, plain sentence and field errors. */

export class LimitsApiError extends Error {
  constructor(message: string, readonly code: string, readonly fieldErrors: Record<string, string[]>) {
    super(message);
  }
}

const viewSchema = z.object({
  target: limitTargetSchema,
  team: limitTeamSchema.extend({ id: z.string() }).nullable(),
  limits: z.array(bookingLimitSchema),
  serviceRules: serviceCustomerRulesSchema.nullable(),
});

async function send(path: string, method: "GET" | "PUT" | "DELETE", body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, {
    method,
    cache: "no-store",
    signal,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result: unknown = await response.json().catch(() => null);
  if (response.ok && typeof result === "object" && result !== null && "data" in result) return (result as { data: unknown }).data;
  const error = typeof result === "object" && result !== null && "error" in result
    ? (result as { error: { code?: string; message?: string; fieldErrors?: Record<string, string[]> } }).error
    : {};
  throw new LimitsApiError(error?.message ?? "That did not work. Try again.", error?.code ?? "error", error?.fieldErrors ?? {});
}

const base = "/api/staff/limits";

export const getLimits = async (scope: LimitScope, scopeId: string, signal?: AbortSignal): Promise<BookingLimitsView> =>
  viewSchema.parse(await send(`${base}?scope=${scope}&scopeId=${encodeURIComponent(scopeId)}`, "GET", undefined, signal));

export const listTeamLimits = async (signal?: AbortSignal): Promise<BookingLimitsView[]> =>
  z.array(viewSchema).parse(await send(`${base}?scope=team`, "GET", undefined, signal));

export const putLimits = async (body: BookingLimitsReplace): Promise<BookingLimitsView> => viewSchema.parse(await send(base, "PUT", body));

export const deleteTeamLimits = async (teamId: string): Promise<void> => { await send(`${base}/teams/${encodeURIComponent(teamId)}`, "DELETE"); };
