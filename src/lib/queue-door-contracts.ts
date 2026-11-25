import { z } from "zod";

/** Requests and results for the door QR code and closing the queue, shared by the routes, the server and the screens. */

const identifier = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export const joinLinkInputSchema = z.strictObject({
  locationId: identifier.optional(),
  /** Turn walk-up sign-ups on or off without changing the link. */
  selfJoinEnabled: z.boolean().optional(),
  /** Make a new door link; the old one stops working at once. */
  newLink: z.boolean().default(false),
});
export type JoinLinkInput = z.input<typeof joinLinkInputSchema>;

export const closeDayInputSchema = z.strictObject({
  locationId: identifier.optional(),
  reason: z.string().trim().min(3, "Say why, in a few words.").max(200),
});
export type CloseDayInput = z.infer<typeof closeDayInputSchema>;

export const doorJoinInputSchema = z.strictObject({
  firstName: z.string().trim().min(1, "Enter a name.").max(80),
  phone: z.string().trim().min(7, "Enter a phone number.").max(32)
    .regex(/^\+?[\d\s()-]+$/, "Use digits, spaces, brackets, dashes and a leading +."),
  practitionerId: identifier.optional(),
  /** Message me when I'm nearly next. */
  notify: z.boolean().default(false),
});
export type DoorJoinInput = z.input<typeof doorJoinInputSchema>;

export interface JoinLinkResult {
  /** Present only when a link was made now. It cannot be shown again; it is stored hashed. */
  link: { path: string } | null;
  selfJoinEnabled: boolean;
}

export interface QueueJoinView {
  businessName: string;
  locationName: string;
  /** False when the day is closed, or the desk has turned door sign-ups off. */
  open: boolean;
  closed: boolean;
  waitingCount: number;
  practitioners: { id: string; name: string }[];
}

export interface QueueDayReport {
  /** Tokens given today. */
  issued: number;
  /** Visits finished. */
  served: number;
  /** Left before being seen, or let go when the day closed. */
  left: number;
  /** Average minutes from arriving to being called, for those who were called; null with no data. */
  averageWaitMinutes: number | null;
}

