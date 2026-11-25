import { z } from "zod";

import { repeatRuleSchema } from "@/lib/series-rule";

/** Group sessions and classes (feature 18): what the staff screens, the public timetable and the routes agree on. */

const id = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export const sessionStatuses = ["scheduled", "cancelled", "completed"] as const;
export type SessionStatus = (typeof sessionStatuses)[number];

export const enrolmentStatuses = ["booked", "waitlisted", "attended", "cancelled", "no_show"] as const;
export type EnrolmentStatus = (typeof enrolmentStatuses)[number];

/** The outbox events the worker turns into messages for a class. */
export const CLASS_NOTICE_EVENT = "class.notice";
export const CLASS_OFFER_EXPIRE_EVENT = "class.offer_expire";

/** Minutes a person offered a freed seat has to answer. */
export const CLASS_OFFER_MINUTES = 120;
/** Never offer a seat so late that the answer time would run past the start. */
export const CLASS_OFFER_MIN_LEAD_MINUTES = 15;

export const MAX_TIMETABLE_SESSIONS = 52;

export const classTypeSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(1000).default(""),
  durationMinutes: z.number().int().min(10).max(480),
  capacity: z.number().int().min(1).max(500),
  priceMinor: z.number().int().min(0).max(100_000_000).nullable().default(null),
  locationIds: z.array(id).min(1).max(40),
  practitionerIds: z.array(id).min(1).max(40),
  requiredResourceKind: z.enum(["room", "chair", "equipment"]).nullable().default(null),
}).strict();
export type ClassTypeInput = z.infer<typeof classTypeSchema>;

/** One session, or a repeating timetable when `repeat` is given (the same rule the repeating appointments use). */
export const createSessionsSchema = z.object({
  serviceId: id,
  practitionerId: id,
  locationId: id,
  /** The first date, `YYYY-MM-DD`, and the clock time, both read at the location. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** Defaults to the class's own seats. */
  capacity: z.number().int().min(1).max(500).optional(),
  repeat: repeatRuleSchema.optional(),
}).strict();
export type CreateSessionsInput = z.infer<typeof createSessionsSchema>;

export const updateSessionSchema = z.object({
  expectedVersion: z.number().int().min(1),
  capacity: z.number().int().min(1).max(500).optional(),
}).strict();

export const cancelSessionSchema = z.object({
  expectedVersion: z.number().int().min(1),
  /** A short line the customers see. Never copied into the audit trail. */
  note: z.string().trim().max(300).optional(),
}).strict();

export const attendanceSchema = z.object({
  enrolmentId: id,
  expectedVersion: z.number().int().min(1),
  outcome: z.enum(["attended", "no_show", "booked"]),
}).strict();

export const walkInSchema = z.object({
  /** An existing customer, or a new one by name. */
  patientId: id.optional(),
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(24).optional(),
  email: z.union([z.email().max(254), z.literal("")]).optional(),
}).strict().refine((value) => value.patientId || value.firstName, { message: "Choose a customer or give a name." });

export const broadcastSchema = z.object({
  message: z.string().trim().min(1).max(500),
  /** Who gets it: everyone with a seat, or also the waiting list. */
  audience: z.enum(["booked", "booked_and_waiting"]).default("booked"),
}).strict();

/** A customer taking a seat from the public timetable. */
export const enrolSchema = z.object({
  clinicSlug: z.string().min(2).max(80),
  firstName: z.string().trim().min(2).max(80),
  lastName: z.string().trim().max(80),
  phone: z.union([z.string().trim().min(8).max(24), z.literal("")]),
  email: z.union([z.email().max(254), z.literal("")]),
  preferredChannel: z.enum(["sms", "email", "whatsapp", "phone"]),
  acceptedPrivacyNotice: z.literal(true),
  messagingConsent: z.boolean().default(false),
  /** When the class is full: join the waiting list instead of being refused. */
  joinWaitlist: z.boolean().default(false),
}).strict().refine((value) => value.email !== "" || value.phone !== "", { message: "Give an email address or a phone number." });
export type EnrolInput = z.infer<typeof enrolSchema>;

export const enrolmentActionSchema = z.object({ action: z.enum(["cancel", "accept_offer", "decline_offer"]) }).strict();

export const timetableQuerySchema = z.object({
  clinicSlug: z.string().min(2).max(80),
  locationId: id.optional(),
  serviceId: id.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

/** What the public page shows for one session. */
export interface TimetableSession {
  id: string;
  serviceId: string;
  serviceName: string;
  locationId: string;
  startsAt: string;
  endsAt: string;
  teacherName: string;
  capacity: number;
  seatsLeft: number;
  /** `open`, `full` (the waiting list is open) or `closed` (starts too soon or already over). */
  state: "open" | "full" | "closed";
  priceMinor: number | null;
  currency: string;
}

export type EnrolResult =
  | { status: "booked"; enrolmentId: string; manageToken: string }
  | { status: "waitlisted"; enrolmentId: string; manageToken: string; position: number };

export interface RosterEntry {
  enrolmentId: string;
  version: number;
  patientId: string;
  name: string;
  status: EnrolmentStatus;
  /** Set while a waiting person holds an offered seat. */
  offerExpiresAt: string | null;
  source: "online" | "staff" | "walk_in";
  /** Place in the line for the waiting, counting from 1. */
  position: number | null;
}

export interface SessionView {
  id: string;
  version: number;
  serviceId: string;
  serviceName: string;
  teacherId: string;
  teacherName: string;
  locationId: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  status: SessionStatus;
  seatsTaken: number;
  waiting: number;
  seriesId: string | null;
}

export interface SessionDetail extends SessionView {
  roster: RosterEntry[];
}

export interface CreateSessionsResult {
  created: number;
  sessionIds: string[];
  seriesId: string | null;
  /** Dates that could not be created, each with a plain reason. Nothing is created when any clash. */
  clashes: Array<{ date: string; reason: string }>;
}
