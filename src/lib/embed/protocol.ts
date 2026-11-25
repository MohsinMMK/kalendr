import { z } from "zod";

/**
 * What a Kalendr booking page tells the website that embeds it (feature 52). Every message carries ids and times only:
 * never a name, email, phone or note. `parseEmbedEvent` drops any field it does not know, so a detail added by mistake
 * somewhere in the booking flow cannot reach the host page.
 */
export const EMBED_PROTOCOL_VERSION = 1;

export const embedEventNames = ["opened", "service_selected", "slot_selected", "booked", "rescheduled", "cancelled", "failed"] as const;
export type EmbedEventName = (typeof embedEventNames)[number];

export function isEmbedEventName(value: unknown): value is EmbedEventName {
  return typeof value === "string" && (embedEventNames as readonly string[]).includes(value);
}

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const timeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/).max(40);

/** The only fields an event may carry. */
export const embedEventDataSchema = z.object({
  serviceId: idSchema.optional(),
  practitionerId: idSchema.optional(),
  appointmentId: idSchema.optional(),
  startsAt: timeSchema.optional(),
  endsAt: timeSchema.optional(),
  /** `booked` or `requested`, for a booking that waits for approval. */
  status: z.enum(["booked", "requested"]).optional(),
  /** Why a booking failed, in a fixed list of words. */
  reason: z.enum(["slot_taken", "validation", "verification", "rate_limited", "network", "unknown"]).optional(),
});
export type EmbedEventData = z.infer<typeof embedEventDataSchema>;

export interface EmbedEvent {
  event: EmbedEventName;
  data: EmbedEventData;
}

/** The window event the booking flow raises and the bridge and the pixels listen for. */
export const EMBED_WINDOW_EVENT = "kalendr:embed-event";

/** Checks an event and keeps only the allowed fields. Null when the name is unknown or a field is malformed. */
export function parseEmbedEvent(event: unknown, data: unknown): EmbedEvent | null {
  if (!isEmbedEventName(event)) return null;
  const parsed = embedEventDataSchema.safeParse(data ?? {});
  return parsed.success ? { event, data: parsed.data } : null;
}

/** Sent to the host page: one message type for every event. */
export const embedMessageSchema = z.object({
  type: z.literal("kalendr:event"),
  version: z.literal(EMBED_PROTOCOL_VERSION),
  nonce: z.string(),
  event: z.enum(embedEventNames),
  data: embedEventDataSchema,
});
export type EmbedMessage = z.infer<typeof embedMessageSchema>;

/** The booking page asks the host to send the visitor to the business's own thank-you page. */
export const embedRedirectMessageSchema = z.object({
  type: z.literal("kalendr:redirect"),
  version: z.literal(EMBED_PROTOCOL_VERSION),
  nonce: z.string(),
  url: z.string().max(1_500),
});
