import { createHash } from "node:crypto";

import { declineReasonLabels, type DeclineReason } from "../lib/approval";
import { QUICK_MESSAGE_EVENT, quickMessageBody, quickMessageKinds, type QuickMessageKind } from "../lib/quick-messages";
import { defaultBusinessProfile, profileWords, type TermWords } from "../lib/terminology";

/** The words a message needs. Callers pass the business's own words; tests and old callers get the healthcare ones. */
export type MessageWords = Pick<TermWords, "customer" | "appointment">;

const defaultMessageWords: MessageWords = profileWords(defaultBusinessProfile);

export interface AppointmentSnapshot {
  id: string;
  version: number;
  status: string;
  confirmationStatus: string;
  startsAt: Date;
  clinicName: string;
  clinicTimezone: string;
  /** Set once the visit has started; quick messages stop then. */
  visitStarted?: boolean;
  /** Today's token, for "It's your turn". */
  queueNumber?: number;
}

export interface OutboxSnapshot {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  dedupeKey: string;
}

export interface CaptureMessage {
  semanticKey: string;
  templateKey: string;
  body: string;
  /** Email subject for workflow messages. The fixed messages leave it out. */
  subject?: string;
  scheduledAt: Date;
}

export type CapturePlan =
  | { kind: "capture"; message: CaptureMessage }
  | { kind: "skip"; reason: "superseded" | "inapplicable" | "no_message" }
  | { kind: "reject"; code: "invalid_event" | "invalid_payload" };

const messageEvents = new Set([
  "appointment.created",
  "appointment.confirm",
  "appointment.reschedule",
  "appointment.suggest",
  "appointment.cancel",
  "appointment.status.booked",
  "appointment.status.cancelled",
  "appointment.status.declined",
  "appointment.status.expired",
  "appointment.reschedule_requested",
  "appointment.reassigned",
  "appointment.location_changed",
  "appointment.reminder",
]);

/** Sent once, a little after a visit is finished. Later edits to the booking don't cancel it. */
const REVIEW_REQUEST_EVENT = "appointment.review_request";

const silentEvents = new Set([
  "appointment.status.requested",
  "appointment.status.checked_in",
  "appointment.status.completed",
  "appointment.status.no_show",
  "appointment.status.entered_in_error",
]);

/**
 * A document became visible to a patient. The message only says something is ready: it never names the document,
 * because it travels over SMS and email and may be read on a shared phone.
 */
export function planRecordSharedCapture(
  event: OutboxSnapshot,
  clinicName: string,
  now: Date,
  words: MessageWords = defaultMessageWords,
): CapturePlan {
  if (event.aggregateType !== "visit_record" || event.eventType !== "record.shared") {
    return { kind: "reject", code: "invalid_event" };
  }
  return {
    kind: "capture",
    message: {
      semanticKey: `local:email:${createHash("sha256").update(event.dedupeKey).digest("hex")}`,
      templateKey: event.eventType,
      body: `${clinicName}: A new document is ready. Sign in to your ${words.customer} portal to see it.`,
      scheduledAt: now,
    },
  };
}

export function planCapture(
  event: OutboxSnapshot,
  appointment: AppointmentSnapshot | null,
  now: Date,
  words: MessageWords = defaultMessageWords,
): CapturePlan {
  const isReviewRequest = event.eventType === REVIEW_REQUEST_EVENT;
  const isQuickMessage = event.eventType === QUICK_MESSAGE_EVENT;
  if (
    event.aggregateType !== "appointment" ||
    !isReviewRequest && !isQuickMessage && !messageEvents.has(event.eventType) && !silentEvents.has(event.eventType)
  ) {
    return { kind: "reject", code: "invalid_event" };
  }
  if (!isPayload(event.payload, event.aggregateId)) {
    return { kind: "reject", code: "invalid_payload" };
  }
  if (isQuickMessage) return planQuickMessage(event, appointment, now, words);
  if (isReviewRequest) {
    if (!appointment || appointment.id !== event.aggregateId) return { kind: "skip", reason: "superseded" };
    if (appointment.status !== "completed") return { kind: "skip", reason: "inapplicable" };
    return {
      kind: "capture",
      message: {
        semanticKey: `local:email:${createHash("sha256").update(event.dedupeKey).digest("hex")}`,
        templateKey: REVIEW_REQUEST_EVENT,
        body: `${appointment.clinicName}: Thanks for your ${words.appointment}. How did it go? Open your manage link to leave a review.`,
        scheduledAt: now,
      },
    };
  }
  if (!appointment || appointment.id !== event.aggregateId || appointment.version !== event.payload.version) {
    return { kind: "skip", reason: "superseded" };
  }
  if (silentEvents.has(event.eventType) || isQuiet(event.payload)) {
    return { kind: "skip", reason: "no_message" };
  }

  const status = appointment.status;
  const eventType = event.eventType;
  const isActive = status === "requested" || status === "booked";
  const isCancellation = eventType === "appointment.cancel" || eventType === "appointment.status.cancelled";
  const isDecline = eventType === "appointment.status.declined";
  const isExpiry = eventType === "appointment.status.expired";
  const isMoveRequest = eventType === "appointment.reschedule_requested";
  if (
    isCancellation ? status !== "cancelled" :
      isDecline ? status !== "declined" :
      isExpiry ? status !== "expired" :
      isMoveRequest ? status !== "reschedule_requested" :
      !isActive ||
      (eventType === "appointment.confirm" && appointment.confirmationStatus !== "confirmed") ||
      (eventType === "appointment.status.booked" && status !== "booked") ||
      (eventType === "appointment.reminder" && appointment.startsAt <= now)
  ) {
    return { kind: "skip", reason: "inapplicable" };
  }

  const scheduledAt = now;
  const semanticKey = `local:email:${createHash("sha256").update(event.dedupeKey).digest("hex")}`;
  const localTime = new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: appointment.clinicTimezone,
    timeZoneName: "short",
  }).format(appointment.startsAt);
  if (isDecline || isExpiry) {
    const payload = event.payload as Record<string, unknown>;
    const note = isDecline && typeof payload.message === "string" ? payload.message.trim().slice(0, 500) : "";
    const reason = isDecline && typeof payload.reason === "string" ? declineReasonLabels[payload.reason as DeclineReason] : undefined;
    return {
      kind: "capture",
      message: {
        semanticKey,
        templateKey: eventType,
        body: isDecline
          ? `${appointment.clinicName}: Sorry, we could not accept your ${words.appointment} request for ${localTime}.${reason ? ` ${reason}.` : ""}${note ? ` ${note}` : ""}`
          : `${appointment.clinicName}: Your ${words.appointment} request for ${localTime} was not answered in time, so it has closed. You are welcome to ask for another time.`,
        scheduledAt,
      },
    };
  }
  if (eventType === "appointment.reassigned" || eventType === "appointment.location_changed") {
    return {
      kind: "capture",
      message: {
        semanticKey,
        templateKey: eventType,
        body: eventType === "appointment.reassigned"
          ? `${appointment.clinicName}: Your ${words.appointment} on ${localTime} is now with a different team member. The time has not changed. Open your manage link for details.`
          : `${appointment.clinicName}: Where your ${words.appointment} on ${localTime} takes place has changed. Open your manage link for details.`,
        scheduledAt,
      },
    };
  }
  if (isMoveRequest) {
    const payload = event.payload as Record<string, unknown>;
    const note = typeof payload.message === "string" ? payload.message.trim().slice(0, 500) : "";
    return {
      kind: "capture",
      message: {
        semanticKey,
        templateKey: eventType,
        body: `${appointment.clinicName}: Please choose a new time for your ${words.appointment} that was on ${localTime}. Open your manage link to pick one.${note ? ` ${note}` : ""}`,
        scheduledAt,
      },
    };
  }
  const action = isCancellation ? "was cancelled" :
    eventType === "appointment.reminder" ? "is coming up" :
      eventType === "appointment.reschedule" ? "was rescheduled" :
        eventType === "appointment.suggest" ? "has a new suggested time" :
        eventType === "appointment.confirm" ? "was confirmed" : "is scheduled";

  return {
    kind: "capture",
    message: {
      semanticKey,
      templateKey: eventType,
      body: `${appointment.clinicName}: Your ${words.appointment} ${action} for ${localTime}.`,
      scheduledAt,
    },
  };
}

/**
 * A message the front desk sent from Today. A later change to the booking doesn't cancel it,
 * but a visit that has started, finished or been cancelled since does.
 */
function planQuickMessage(
  event: OutboxSnapshot,
  appointment: AppointmentSnapshot | null,
  now: Date,
  words: MessageWords,
): CapturePlan {
  const payload = event.payload as Record<string, unknown>;
  const kind = payload.kind as QuickMessageKind;
  const delayMinutes = payload.delayMinutes;
  if (
    !quickMessageKinds.includes(kind) ||
    (kind === "running_late" && (typeof delayMinutes !== "number" || !Number.isSafeInteger(delayMinutes) || delayMinutes <= 0))
  ) {
    return { kind: "reject", code: "invalid_payload" };
  }
  if (!appointment || appointment.id !== event.aggregateId) return { kind: "skip", reason: "superseded" };
  if (!["requested", "booked", "checked_in"].includes(appointment.status) || appointment.visitStarted) {
    return { kind: "skip", reason: "inapplicable" };
  }
  const startsAt = new Intl.DateTimeFormat("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: appointment.clinicTimezone,
  }).format(appointment.startsAt);
  const body = quickMessageBody(kind, words, {
    delayMinutes: typeof delayMinutes === "number" ? delayMinutes : undefined,
    queueNumber: appointment.queueNumber,
    startsAt,
  });
  return {
    kind: "capture",
    message: {
      semanticKey: `local:email:${createHash("sha256").update(event.dedupeKey).digest("hex")}`,
      templateKey: `${QUICK_MESSAGE_EVENT}.${kind}`,
      body: `${appointment.clinicName}: ${body}`,
      scheduledAt: now,
    },
  };
}

/** The change was queued with notifyCustomer false (an import, or "don't tell the customer"): nothing is sent for it. */
function isQuiet(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && "notifyCustomer" in payload && payload.notifyCustomer === false;
}

function isPayload(value: unknown, aggregateId: string): value is { appointmentId: string; version: number } {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return payload.appointmentId === aggregateId &&
    typeof payload.version === "number" &&
    Number.isSafeInteger(payload.version) &&
    payload.version > 0;
}

export function retryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(10, attemptCount - 1));
  return Math.min(60 * 60 * 1_000, 5_000 * 2 ** exponent);
}
