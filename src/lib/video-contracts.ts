import { z } from "zod";

/**
 * Video visits (feature 19): the words shared by the server, the call screens and the settings screen.
 * Nothing here touches the database or the network.
 */

export const deliveryModes = ["in_person", "video", "phone"] as const;
export type DeliveryMode = (typeof deliveryModes)[number];
export const deliveryModeSchema = z.enum(deliveryModes);
export const deliveryModeLabels: Record<DeliveryMode, string> = { in_person: "In person", video: "Video call", phone: "Phone call" };

/** People can open the call this long before the start, and until this long after the end. */
export const VISIT_OPENS_BEFORE_MINUTES = 15;
export const VISIT_CLOSES_AFTER_MINUTES = 30;
/** A person counts as "here" while their call screen has sent a heartbeat this recently. */
export const PRESENCE_SECONDS = 45;

/**
 * not_video: this visit is not a video call. cancelled. not_open_yet: more than 15 minutes before the start.
 * preparing: the window is open but the room is not made yet (the worker is about to). open: ready to join.
 * ended: more than 30 minutes after the end.
 */
export type VisitState = "not_video" | "cancelled" | "not_open_yet" | "preparing" | "open" | "ended";
export type CustomerStage = "none" | "waiting" | "admitted";
/** `test` is local test mode: only your own camera is shown. */
export type VideoProviderMode = "daily" | "test";

export interface VisitStatusView {
  state: VisitState;
  startsAt: string;
  endsAt: string;
  opensAt: string;
  closesAt: string;
  businessName: string;
  businessPhone: string | null;
  serviceName: string;
  staffName: string;
  customerFirstName: string;
  /** Whether the staff member's call screen is open right now: "Dr Rao has not joined yet". */
  staffPresent: boolean;
  customerStage: CustomerStage;
  provider: VideoProviderMode;
}

/** What a person needs to join the call. The token is for them alone and works only around the visit. */
export interface VisitEnterView {
  provider: VideoProviderMode;
  roomUrl: string;
  meetingToken: string;
  expiresAt: string;
  displayName: string;
}

export const visitActionSchema = z.discriminatedUnion("action", [
  /** Customer: "I'm here, let me in." Marks the booking checked in and puts them in the waiting room. */
  z.object({ action: z.literal("wait") }),
  /** Customer: after staff admit them, ask for their meeting token. */
  z.object({ action: z.literal("enter") }),
  /** Customer: still here. Sent every 20 seconds while the screen is open. */
  z.object({ action: z.literal("heartbeat") }),
]);
export type VisitAction = z.infer<typeof visitActionSchema>;

export interface StaffVideoView {
  state: VisitState;
  startsAt: string;
  endsAt: string;
  opensAt: string;
  closesAt: string;
  provider: VideoProviderMode;
  customerFirstName: string;
  customerStage: CustomerStage;
  /** The customer's call screen is open right now (waiting or in the call). */
  customerPresent: boolean;
  staffPresent: boolean;
  businessPhone: string | null;
}

export const staffVideoActionSchema = z.discriminatedUnion("action", [
  /** Staff: open the call. Marks the staff member present and returns their host token. */
  z.object({ action: z.literal("host") }),
  /** Staff: let the waiting customer in. */
  z.object({ action: z.literal("admit") }),
  /** Staff: still here. Sent every 20 seconds while the call screen is open. */
  z.object({ action: z.literal("heartbeat") }),
]);
export type StaffVideoAction = z.infer<typeof staffVideoActionSchema>;

export interface StaffVideoHostView {
  status: StaffVideoView;
  enter: VisitEnterView;
}
