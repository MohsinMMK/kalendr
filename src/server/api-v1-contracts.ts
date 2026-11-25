import { z } from "zod";
import "zod-openapi";

/**
 * The shapes of the public API, version 1 (feature 34). Their names and fields are a promise to integrators:
 * add fields, never rename or remove one. They are deliberately separate from the app's own contracts so an
 * internal rename can never change what a customer's integration receives. The OpenAPI document is built from
 * these same schemas (src/server/openapi.ts), so the reference cannot drift from what the routes accept.
 */

export const appointmentStatuses = ["requested", "booked", "checked_in", "completed", "cancelled", "no_show", "entered_in_error", "pending_payment", "expired", "declined", "reschedule_requested"] as const;
export const appointmentSources = ["online", "staff", "widget", "recall", "waitlist", "iframe", "phone", "walk_in", "assistant"] as const;

const id = (description: string, example: string) => z.string().meta({ description, example });
const timestamp = (description: string, example: string) => z.iso.datetime({ offset: true }).meta({ description, example });
/** A path or body identifier: the same shape the app accepts, so a stray value is a clean 400 or 404. */
export const identifier = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export const serviceSchema = z.object({
  id: id("The service's id.", "svc_4f1c"),
  name: z.string().meta({ example: "Dental cleaning" }),
  description: z.string(),
  durationMinutes: z.number().int().meta({ description: "The usual length of a visit.", example: 45 }),
  priceMinor: z.number().int().nullable().meta({ description: "Price in the currency's smallest unit (paise for INR). Null when the price varies.", example: 80000 }),
  priceLabel: z.string().nullable().meta({ example: "From Rs 800" }),
  category: z.string().nullable(),
  bookingMode: z.enum(["instant", "request"]).meta({ description: "`instant` confirms at once; `request` waits for the business to accept." }),
  isActive: z.boolean(),
}).meta({ id: "Service" });

export const staffSchema = z.object({
  id: id("The staff member's id.", "stf_81aa"),
  name: z.string().meta({ example: "Dr Kavya Rao" }),
  title: z.string().meta({ example: "Dentist" }),
  specialty: z.string(),
  isActive: z.boolean(),
}).meta({ id: "Staff" });

export const slotSchema = z.object({
  startsAt: timestamp("When the slot starts.", "2026-12-01T09:30:00.000Z"),
  endsAt: timestamp("When the slot ends.", "2026-12-01T10:15:00.000Z"),
  staffId: id("Who the slot is with.", "stf_81aa"),
  resourceId: z.string().optional().meta({ description: "The room or chair the slot holds, when the service needs one." }),
}).meta({ id: "Slot" });

export const appointmentSchema = z.object({
  id: id("The appointment's id.", "apt_77d2"),
  status: z.enum(appointmentStatuses),
  startsAt: timestamp("Start time.", "2026-12-01T09:30:00.000Z"),
  endsAt: timestamp("End time.", "2026-12-01T10:15:00.000Z"),
  serviceId: z.string(),
  staffId: z.string(),
  customerId: z.string(),
  locationId: z.string(),
  source: z.enum(appointmentSources).meta({ description: "How the appointment was made. Bookings through the API appear as `staff`." }),
  notes: z.string().nullable().meta({ description: "Internal notes. Never shown to the customer." }),
  reasonForVisit: z.string().nullable(),
  version: z.number().int().meta({ description: "Counts up on every change. Send it back to change or cancel to guard against overwriting someone else's edit.", example: 1 }),
  createdAt: timestamp("When it was made.", "2026-11-20T08:00:00.000Z"),
  cancelledAt: timestamp("When it was cancelled, if it was.", "2026-11-25T08:00:00.000Z").nullable(),
}).meta({ id: "Appointment" });

export const customerSchema = z.object({
  id: id("The customer's id.", "cus_19ab"),
  firstName: z.string(),
  lastName: z.string(),
  phone: z.string().meta({ example: "+919000000001" }),
  email: z.string().meta({ example: "asha@example.com" }),
  dateOfBirth: z.string().nullable().meta({ description: "YYYY-MM-DD, when known.", example: "1990-04-12" }),
  tags: z.array(z.string()).meta({ description: "The business's own labels on this customer, such as \"VIP\".", example: ["VIP"] }),
  blocked: z.boolean().meta({ description: "True when the business has blocked this customer from booking online." }),
  createdAt: timestamp("When the customer was added.", "2026-11-20T08:00:00.000Z"),
}).meta({ id: "Customer" });

export const errorSchema = z.object({
  error: z.object({
    code: z.string().meta({ description: "A stable machine-readable code, such as `insufficient_scope` or `slot_unavailable`.", example: "validation_error" }),
    message: z.string().meta({ description: "A sentence for a person. Do not match on it." }),
    fieldErrors: z.record(z.string(), z.array(z.string())).optional().meta({ description: "Problems per field, on a 400." }),
  }),
}).meta({ id: "Error" });

export type V1Service = z.infer<typeof serviceSchema>;
export type V1Staff = z.infer<typeof staffSchema>;
export type V1Slot = z.infer<typeof slotSchema>;
export type V1Appointment = z.infer<typeof appointmentSchema>;
export type V1Customer = z.infer<typeof customerSchema>;

/** `{ data: T }` for one object. */
export function oneOf<T extends z.ZodType>(schema: T) {
  return z.object({ data: schema });
}

/** `{ data: [T], nextCursor, hasMore }` for a list. */
export function listOf<T extends z.ZodType>(schema: T) {
  return z.object({
    data: z.array(schema),
    nextCursor: z.string().nullable().meta({ description: "Pass as `cursor` for the next page. Null on the last page." }),
    hasMore: z.boolean(),
  });
}

// Requests

export const dateFilter = z.iso.datetime({ offset: true });

export const availabilityQuery = z.object({
  serviceId: identifier.meta({ description: "The service to find times for." }),
  staffId: identifier.optional().meta({ description: "Limit to one staff member. Omit for whoever is first free." }),
  locationId: identifier.optional().meta({ description: "Defaults to the business's first active location." }),
  from: dateFilter.meta({ description: "Start of the range, ISO 8601 with an offset." }),
  to: dateFilter.meta({ description: "End of the range. At most 31 days after `from`." }),
  durationMinutes: z.coerce.number().int().min(5).max(480).optional().meta({ description: "One of the lengths the service offers. Defaults to its usual length." }),
}).refine((value) => new Date(value.to).getTime() > new Date(value.from).getTime(), { path: ["to"], message: "`to` must be after `from`." })
  .refine((value) => new Date(value.to).getTime() - new Date(value.from).getTime() <= 31 * 86_400_000, { path: ["to"], message: "Ask for at most 31 days at a time." });

export const newCustomerBody = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).default(""),
  phone: z.string().trim().min(7).max(32).meta({ example: "+919000000001" }),
  email: z.email().max(254),
  dateOfBirth: z.iso.date().optional().meta({ description: "YYYY-MM-DD." }),
}).meta({ id: "NewCustomer" });

export const createAppointmentBody = z.object({
  serviceId: identifier,
  staffId: identifier.meta({ description: "Take this from a slot returned by the availability call." }),
  startsAt: dateFilter.meta({ description: "The slot's `startsAt`. Times that are taken are refused with `slot_unavailable`, and times closed by a booking rule (such as minimum notice) with `outside_booking_rules`." }),
  locationId: identifier.optional().meta({ description: "Defaults to the business's first active location." }),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  customerId: identifier.optional().meta({ description: "An existing customer. Send this or `customer`, not both." }),
  customer: newCustomerBody.optional().meta({ description: "A new customer to add with the booking." }),
  notes: z.string().trim().max(2000).optional(),
  reasonForVisit: z.string().trim().max(500).optional(),
}).refine((value) => Boolean(value.customerId) !== Boolean(value.customer), { path: ["customerId"], message: "Send exactly one of customerId or customer." })
  .meta({ id: "CreateAppointment" });

export const rescheduleBody = z.object({
  startsAt: dateFilter,
  staffId: identifier.optional().meta({ description: "Move to another staff member. Defaults to the current one." }),
  version: z.number().int().positive().optional().meta({ description: "The appointment's `version`. Send it to refuse the change if someone edited the appointment since you read it." }),
}).meta({ id: "RescheduleAppointment" });

export const cancelBody = z.object({
  reason: z.string().trim().min(3).max(300).optional(),
  version: z.number().int().positive().optional().meta({ description: "The appointment's `version`, for the same guard as rescheduling." }),
}).meta({ id: "CancelAppointment" });

export const appointmentListQuery = z.object({
  from: dateFilter.optional().meta({ description: "Appointments starting at or after this time." }),
  to: dateFilter.optional().meta({ description: "Appointments starting before this time." }),
  status: z.enum(appointmentStatuses).optional(),
  customerId: identifier.optional(),
});

export const customerListQuery = z.object({
  phone: z.string().trim().min(5).max(32).optional().meta({ description: "Matches however the number is written (spaces, dashes, country code)." }),
  email: z.string().trim().min(3).max(254).optional().meta({ description: "Case-insensitive exact match." }),
});
