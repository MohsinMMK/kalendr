/**
 * What the calendar-sync screens and routes agree on (feature 16). Client-safe: no database, no secrets.
 * The server shapes its answers with these schemas and the screen parses them, so a drift shows up in tests.
 */
import { z } from "zod";

export const calendarProviderIds = ["google", "microsoft", "apple"] as const;
export const calendarProviderSchema = z.enum(calendarProviderIds);
export type CalendarProviderName = z.infer<typeof calendarProviderSchema>;

/** Plain names for the buttons and cards. */
export const calendarProviderLabels: Record<CalendarProviderName, string> = {
  google: "Google Calendar",
  microsoft: "Outlook",
  apple: "Apple Calendar",
};

/**
 * pending: saved, the worker has not checked it yet (Apple connects this way).
 * active: working. needs_reconnect: the provider refused our login; the person must sign in again.
 */
export const connectionStatusSchema = z.enum(["pending", "active", "needs_reconnect"]);
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

/** How much of an appointment is written into someone's own calendar (and the .ics feed). */
export const eventTextSchema = z.enum(["full", "first_name_service", "busy_only"]);
export type EventTextSetting = z.infer<typeof eventTextSchema>;

export const eventTextLabels: Record<EventTextSetting, { label: string; description: string }> = {
  full: { label: "Full details", description: "Name, service and a link back to the appointment." },
  first_name_service: { label: "First name and service", description: "For example “Priya – Haircut”. Nothing else." },
  busy_only: { label: "Just “Busy”", description: "Nobody who can see the calendar learns who is booked." },
};

/** Most calendar accounts one staff member can connect. Feature 14 will replace this with a per-plan number. */
export const MAX_CALENDAR_CONNECTIONS_PER_STAFF = 3;

/** Why a provider cannot be used right now. Shown as plain text next to a disabled button. */
export const providerAvailabilitySchema = z.object({
  provider: calendarProviderSchema,
  available: z.boolean(),
  /** Set when not available: "Ask your administrator to add the Google keys", "Not available in the preview". */
  reason: z.string().nullable(),
});
export type ProviderAvailability = z.infer<typeof providerAvailabilitySchema>;

export const calendarSelectionViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Which calendar of the account: the primary one is listed first. */
  primary: z.boolean(),
  canWrite: z.boolean(),
  blocksAvailability: z.boolean(),
  writesHere: z.boolean(),
  lastSyncedAt: z.string().nullable(),
  version: z.number().int(),
});
export type CalendarSelectionView = z.infer<typeof calendarSelectionViewSchema>;

export const calendarConnectionViewSchema = z.object({
  id: z.string(),
  provider: calendarProviderSchema,
  accountEmail: z.string().nullable(),
  status: connectionStatusSchema,
  /** A short code such as "revoked"; never provider text. */
  lastErrorCode: z.string().nullable(),
  /** Whose calendar it is (the owner sees everyone's status, but only the person can change theirs). */
  ownerName: z.string(),
  mine: z.boolean(),
  /** Empty until the worker has listed the calendars. */
  calendars: z.array(calendarSelectionViewSchema),
});
export type CalendarConnectionView = z.infer<typeof calendarConnectionViewSchema>;

export const calendarConflictViewSchema = z.object({
  id: z.string(),
  appointmentId: z.string(),
  /** "moved": the calendar event now sits at another time. "deleted": the event is gone. */
  kind: z.enum(["moved", "deleted"]),
  /** The appointment's own time, which Kalendr never changes by itself. */
  appointmentStartsAt: z.string(),
  appointmentEndsAt: z.string(),
  /** Where the calendar event is now; null when it was deleted. */
  eventStartsAt: z.string().nullable(),
  eventEndsAt: z.string().nullable(),
  ownerName: z.string(),
  createdAt: z.string(),
});
export type CalendarConflictView = z.infer<typeof calendarConflictViewSchema>;

export const calendarFeedViewSchema = z.object({
  active: z.boolean(),
  createdAt: z.string().nullable(),
});
export type CalendarFeedView = z.infer<typeof calendarFeedViewSchema>;

export const calendarOverviewSchema = z.object({
  /** "unavailable": preview mode or no database. "fake": local test accounts, no real provider is contacted. */
  mode: z.enum(["live", "fake", "unavailable"]),
  providers: z.array(providerAvailabilitySchema),
  maxConnections: z.number().int(),
  connections: z.array(calendarConnectionViewSchema),
  conflicts: z.array(calendarConflictViewSchema),
  eventText: eventTextSchema,
  /** The owner and admins may change the business-wide event text. */
  canManageSettings: z.boolean(),
  feed: calendarFeedViewSchema,
});
export type CalendarOverview = z.infer<typeof calendarOverviewSchema>;

/** POST /api/staff/calendars/connect/apple: an Apple ID and an app-specific password, never the Apple ID password. */
export const appleConnectInputSchema = z.object({
  appleId: z.string().trim().email("Enter the email address of your Apple ID.").max(254),
  appPassword: z
    .string()
    .trim()
    .regex(/^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/, "An app-specific password looks like abcd-efgh-ijkl-mnop."),
});
export type AppleConnectInput = z.infer<typeof appleConnectInputSchema>;

/** PATCH /api/staff/calendars/selections/[id]: tick "blocks my availability" or choose where new bookings go. */
export const selectionPatchSchema = z
  .object({
    blocksAvailability: z.boolean().optional(),
    /** true makes this the one calendar new bookings are written to; false stops writing here. */
    writesHere: z.boolean().optional(),
    version: z.number().int().positive(),
  })
  .refine((value) => value.blocksAvailability !== undefined || value.writesHere !== undefined, "Nothing to change.");
export type SelectionPatch = z.infer<typeof selectionPatchSchema>;

/** PUT /api/staff/calendars/settings (owner or admin). */
export const calendarSettingsInputSchema = z.object({ eventText: eventTextSchema });

/** POST /api/staff/calendars/conflicts/[id] */
export const conflictActionSchema = z.object({
  action: z.enum(["move_appointment", "restore_event", "dismiss"]),
});
export type ConflictAction = z.infer<typeof conflictActionSchema>;

/** POST /api/staff/calendars/feed answers with the address once; only its hash is kept. */
export const feedCreatedSchema = z.object({ url: z.string().url(), createdAt: z.string() });

/** The one outbox event types this feature owns. */
export const CALENDAR_WRITE_EVENT = "calendar.write";
export const CALENDAR_SYNC_EVENT = "calendar.sync";
export const CALENDAR_RENEW_EVENT = "calendar.renew";
export const CALENDAR_VERIFY_EVENT = "calendar.verify";
export const CALENDAR_DISCONNECT_EVENT = "calendar.disconnect";

/** Sealed-secret purposes (src/server/keys/secrets.ts). */
export const CALENDAR_CREDENTIALS_PURPOSE = "calendar.credentials";
