/**
 * The rules for when a video visit can be joined and who counts as present. Pure functions on a clock.
 * No "server-only": the worker names rooms with these too.
 */
import { createHash } from "node:crypto";

import {
  PRESENCE_SECONDS,
  VISIT_CLOSES_AFTER_MINUTES,
  VISIT_OPENS_BEFORE_MINUTES,
  type CustomerStage,
  type VisitState,
} from "@/lib/video-contracts";

const MINUTE = 60_000;

export interface VisitWindow {
  opensAt: Date;
  closesAt: Date;
}

export function visitWindow(startsAt: Date, endsAt: Date): VisitWindow {
  return {
    opensAt: new Date(startsAt.getTime() - VISIT_OPENS_BEFORE_MINUTES * MINUTE),
    closesAt: new Date(endsAt.getTime() + VISIT_CLOSES_AFTER_MINUTES * MINUTE),
  };
}

/** The provider's room name for a booking. Stable, so a retry after a crash finds the same room; not a secret. */
export function roomNameFor(tenantId: string, appointmentId: string): string {
  return `v-${createHash("sha256").update(`kalendr-video:${tenantId}:${appointmentId}`).digest("hex").slice(0, 28)}`;
}

/** When a room stops working: 30 minutes after the visit's end. */
export function roomExpiry(endsAt: Date): Date {
  return new Date(endsAt.getTime() + VISIT_CLOSES_AFTER_MINUTES * MINUTE);
}

export function visitState(input: {
  deliveryMode: string;
  status: string;
  window: VisitWindow;
  roomActive: boolean;
  now: Date;
}): VisitState {
  if (input.deliveryMode !== "video") return "not_video";
  if (input.status === "cancelled" || input.status === "entered_in_error") return "cancelled";
  if (input.now < input.window.opensAt) return "not_open_yet";
  if (input.now >= input.window.closesAt) return "ended";
  return input.roomActive ? "open" : "preparing";
}

/** A person is "here" while their call screen sent a heartbeat in the last 45 seconds. */
export function isPresent(seenAt: Date | null, now: Date): boolean {
  return seenAt !== null && now.getTime() - seenAt.getTime() <= PRESENCE_SECONDS * 1_000;
}

export function customerStage(room: { customerWaitingAt: Date | null; customerAdmittedAt: Date | null } | null): CustomerStage {
  if (room?.customerAdmittedAt) return "admitted";
  if (room?.customerWaitingAt) return "waiting";
  return "none";
}

/** How a visit happens, from the way of meeting the customer chose at booking: a video call, a phone call, or in person. */
export function deliveryModeForKind(kind: string | null | undefined): "in_person" | "video" | "phone" {
  if (kind === "video") return "video";
  if (kind === "we_call" || kind === "they_call") return "phone";
  return "in_person";
}
