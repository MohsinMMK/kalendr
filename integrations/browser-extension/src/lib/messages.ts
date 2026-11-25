import { z } from "zod";

import { ApiFailure, SignedOutError, type ConnectPoll, type ConnectStart, type KalendrClient } from "./client";
import type { EmailTimes, Service, Today } from "./schemas";

/**
 * What the popup asks the background worker to do, and what comes back. The popup never holds a token or calls Kalendr
 * itself, so there is one place that renews tokens and one place that can be wrong about it.
 */

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const requestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status") }),
  z.object({ type: z.literal("connect.start") }),
  z.object({ type: z.literal("connect.poll") }),
  z.object({ type: z.literal("connect.cancel") }),
  z.object({ type: z.literal("connect.key"), key: z.string().max(200) }),
  z.object({ type: z.literal("disconnect") }),
  z.object({ type: z.literal("me") }),
  z.object({ type: z.literal("services") }),
  z.object({ type: z.literal("today") }),
  z.object({ type: z.literal("emailTimes"), serviceId: id }),
  z.object({ type: z.literal("createLink"), serviceId: id, label: z.string().max(80).optional() }),
]);
export type Request = z.infer<typeof requestSchema>;

export interface ReplyData {
  status: { connected: boolean; pending: ConnectStart | null };
  "connect.start": ConnectStart;
  "connect.poll": ConnectPoll;
  "connect.cancel": null;
  "connect.key": null;
  disconnect: null;
  me: { businessName: string; businessSlug: string; scopes: string[] };
  services: Service[];
  today: Today;
  emailTimes: EmailTimes;
  createLink: { id: string; url: string };
}

export type Failure = { kind: "signed_out"; message: string } | { kind: "api"; message: string; code: string; status: number } | { kind: "unexpected"; message: string };

export type Reply<T extends Request["type"]> = { ok: true; data: ReplyData[T] } | { ok: false; error: Failure };

export function toFailure(error: unknown): Failure {
  if (error instanceof SignedOutError) return { kind: "signed_out", message: error.message };
  if (error instanceof ApiFailure) return { kind: "api", message: error.message, code: error.code, status: error.status };
  return { kind: "unexpected", message: "Something went wrong. Try again." };
}

/** Runs one request. Errors become values so they cross the message boundary intact. */
export async function handle(request: Request, client: KalendrClient): Promise<Reply<Request["type"]>> {
  try {
    switch (request.type) {
      case "status": return { ok: true, data: { connected: await client.connected(), pending: await client.pending() } };
      case "connect.start": return { ok: true, data: await client.startConnect() };
      case "connect.poll": return { ok: true, data: await client.pollConnect() };
      case "connect.cancel": await client.cancelConnect(); return { ok: true, data: null };
      case "connect.key": await client.connectWithKey(request.key); return { ok: true, data: null };
      case "disconnect": await client.disconnect(); return { ok: true, data: null };
      case "me": return { ok: true, data: await client.me() };
      case "services": return { ok: true, data: await client.services() };
      case "today": return { ok: true, data: await client.today() };
      case "emailTimes": return { ok: true, data: await client.emailTimes(request.serviceId) };
      case "createLink": return { ok: true, data: await client.createLink(request.serviceId, request.label) };
    }
  } catch (error: unknown) {
    return { ok: false, error: toFailure(error) };
  }
}
