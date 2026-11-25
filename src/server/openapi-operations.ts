import { z } from "zod";

import type { ApiScope } from "@/lib/api-scopes";
import {
  appointmentListQuery, appointmentSchema, availabilityQuery, cancelBody, createAppointmentBody, customerListQuery,
  customerSchema, listOf, newCustomerBody, oneOf, rescheduleBody, serviceSchema, slotSchema, staffSchema,
} from "@/server/api-v1-contracts";

/**
 * The public API, listed once: path, method, scope, request and response schemas, and a worked example for each
 * call. The OpenAPI document (src/server/openapi.ts) and the /developers page are both built from this list, and
 * a test checks it against the route files, so a route cannot exist without being documented or the other way round.
 */

export interface ApiOperation {
  id: string;
  method: "get" | "post";
  /** OpenAPI style: `{id}` for a path value. */
  path: string;
  scope: ApiScope;
  summary: string;
  description: string;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** The id in the path, with what it identifies. */
  pathParam?: { name: string; description: string };
  idempotent?: boolean;
  paged?: boolean;
  success: { status: 200 | 201; schema: z.ZodType; description: string };
  /** Error codes this call can return beyond the shared ones (401, 403, 429). */
  errors: Array<{ status: number; code: string; description: string }>;
  requestExample?: unknown;
  responseExample: unknown;
  /** The query string used in the curl example. */
  queryExample?: string;
}

const pagingQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25).meta({ description: "Page size, 1 to 100.", example: 25 }),
  cursor: z.string().min(1).max(400).optional().meta({ description: "The `nextCursor` of the previous page." }),
});

const exampleService = { id: "svc_4f1c", name: "Dental cleaning", description: "A routine cleaning visit.", durationMinutes: 45, priceMinor: 80000, priceLabel: "Rs 800", category: null, bookingMode: "instant", isActive: true };
const exampleStaff = { id: "stf_81aa", name: "Dr Kavya Rao", title: "Dentist", specialty: "General dentistry", isActive: true };
const exampleAppointment = {
  id: "apt_77d2", status: "booked", startsAt: "2026-12-01T09:30:00.000Z", endsAt: "2026-12-01T10:15:00.000Z", serviceId: "svc_4f1c",
  staffId: "stf_81aa", customerId: "cus_19ab", locationId: "loc_02be", source: "staff", notes: null, reasonForVisit: "Check-up",
  version: 1, createdAt: "2026-11-20T08:00:00.000Z", cancelledAt: null,
};
const exampleCustomer = { id: "cus_19ab", firstName: "Asha", lastName: "Mehta", phone: "+919000000001", email: "asha@example.com", dateOfBirth: null, createdAt: "2026-11-20T08:00:00.000Z" };
const exampleSlot = { startsAt: "2026-12-01T09:30:00.000Z", endsAt: "2026-12-01T10:15:00.000Z", staffId: "stf_81aa" };

const list = (item: unknown) => ({ data: [item], nextCursor: null, hasMore: false });
const one = (item: unknown) => ({ data: item });
const idParam = (what: string) => ({ name: "id", description: `The ${what}'s id.` });
const notFound = (code: string, what: string) => ({ status: 404, code, description: `No ${what} with that id in this business.` });
const versionConflict = { status: 409, code: "version_conflict", description: "The appointment changed since the `version` you sent. Read it again." };
const slotGone = { status: 409, code: "slot_unavailable", description: "That time is not offered. Ask for availability again." };

export const apiOperations: readonly ApiOperation[] = [
  {
    id: "listServices", method: "get", path: "/api/v1/services", scope: "services:read", summary: "List services",
    description: "The services the business offers, including inactive ones (see `isActive`).",
    query: pagingQuery, paged: true,
    success: { status: 200, schema: listOf(serviceSchema), description: "A page of services." },
    errors: [], responseExample: list(exampleService),
  },
  {
    id: "listStaff", method: "get", path: "/api/v1/staff", scope: "staff:read", summary: "List staff",
    description: "The staff who take bookings.", query: pagingQuery, paged: true,
    success: { status: 200, schema: listOf(staffSchema), description: "A page of staff." },
    errors: [], responseExample: list(exampleStaff),
  },
  {
    id: "listAvailability", method: "get", path: "/api/v1/availability", scope: "availability:read", summary: "Find open times",
    description: "Open slots for a service in a date range, exactly the times the booking page would offer. Omit `staffId` for whoever is first free. Book one by sending its `startsAt` and `staffId` to create an appointment.",
    query: availabilityQuery,
    success: { status: 200, schema: listOf(slotSchema), description: "Open slots, earliest first. `nextCursor` is always null." },
    errors: [{ status: 404, code: "service_not_found", description: "No service with that id." }],
    responseExample: list(exampleSlot),
    queryExample: "serviceId=svc_4f1c&from=2026-12-01T00:00:00Z&to=2026-12-08T00:00:00Z",
  },
  {
    id: "listAppointments", method: "get", path: "/api/v1/appointments", scope: "appointments:read", summary: "List appointments",
    description: "Appointments, newest start time first. Filter by time range, status or customer.",
    query: pagingQuery.extend(appointmentListQuery.shape), paged: true,
    success: { status: 200, schema: listOf(appointmentSchema), description: "A page of appointments." },
    errors: [], responseExample: list(exampleAppointment),
  },
  {
    id: "createAppointment", method: "post", path: "/api/v1/appointments", scope: "appointments:write", summary: "Book an appointment",
    description: "Books through the same checks as the staff app: the time must be offered, limits apply, and the booking is confirmed. Send an existing `customerId` or a new `customer`. `Idempotency-Key` is required; repeating a call with the same key and body returns the same appointment.",
    body: createAppointmentBody, idempotent: true,
    success: { status: 201, schema: oneOf(appointmentSchema), description: "The new appointment." },
    errors: [slotGone, { status: 404, code: "customer_not_found", description: "No customer with that `customerId`." }, { status: 409, code: "idempotency_conflict", description: "The Idempotency-Key was used with a different body." }, { status: 422, code: "feature_off", description: "The business has turned this feature off." }],
    requestExample: { serviceId: "svc_4f1c", staffId: "stf_81aa", startsAt: "2026-12-01T09:30:00.000Z", customer: { firstName: "Asha", lastName: "Mehta", phone: "+919000000001", email: "asha@example.com" }, reasonForVisit: "Check-up" },
    responseExample: one(exampleAppointment),
  },
  {
    id: "getAppointment", method: "get", path: "/api/v1/appointments/{id}", scope: "appointments:read", summary: "Get an appointment",
    description: "One appointment.", pathParam: idParam("appointment"),
    success: { status: 200, schema: oneOf(appointmentSchema), description: "The appointment." },
    errors: [notFound("appointment_not_found", "appointment")], responseExample: one(exampleAppointment),
  },
  {
    id: "rescheduleAppointment", method: "post", path: "/api/v1/appointments/{id}/reschedule", scope: "appointments:write", summary: "Move an appointment",
    description: "Moves an appointment to a new offered time. Without `version` the current version is read first, so a change made between your read and this call is not detected; send `version` for optimistic concurrency.",
    pathParam: idParam("appointment"), body: rescheduleBody,
    success: { status: 200, schema: oneOf(appointmentSchema), description: "The updated appointment." },
    errors: [notFound("appointment_not_found", "appointment"), slotGone, versionConflict],
    requestExample: { startsAt: "2026-12-02T10:00:00.000Z", version: 1 }, responseExample: one({ ...exampleAppointment, startsAt: "2026-12-02T10:00:00.000Z", endsAt: "2026-12-02T10:45:00.000Z", version: 2 }),
  },
  {
    id: "cancelAppointment", method: "post", path: "/api/v1/appointments/{id}/cancel", scope: "appointments:write", summary: "Cancel an appointment",
    description: "Cancels an appointment and frees its time. The body is optional. Same `version` rule as rescheduling.",
    pathParam: idParam("appointment"), body: cancelBody,
    success: { status: 200, schema: oneOf(appointmentSchema), description: "The cancelled appointment." },
    errors: [notFound("appointment_not_found", "appointment"), versionConflict, { status: 409, code: "invalid_status_transition", description: "That appointment cannot be cancelled from its current status." }],
    requestExample: { reason: "Customer asked to cancel", version: 1 }, responseExample: one({ ...exampleAppointment, status: "cancelled", version: 2, cancelledAt: "2026-11-25T08:00:00.000Z" }),
  },
  {
    id: "listCustomers", method: "get", path: "/api/v1/customers", scope: "customers:read", summary: "List or find customers",
    description: "Customers, newest first. Filter by `phone` or `email` to find one before booking.",
    query: pagingQuery.extend(customerListQuery.shape), paged: true,
    success: { status: 200, schema: listOf(customerSchema), description: "A page of customers." },
    errors: [], responseExample: list(exampleCustomer), queryExample: "email=asha@example.com",
  },
  {
    id: "createCustomer", method: "post", path: "/api/v1/customers", scope: "customers:write", summary: "Add a customer",
    description: "Adds a customer. `Idempotency-Key` is required; repeating a call with the same key and body returns the same customer. Triggers a `customer.created` webhook.",
    body: newCustomerBody, idempotent: true,
    success: { status: 201, schema: oneOf(customerSchema), description: "The new customer." },
    errors: [{ status: 409, code: "idempotency_conflict", description: "The Idempotency-Key was used with a different body." }],
    requestExample: { firstName: "Asha", lastName: "Mehta", phone: "+919000000001", email: "asha@example.com" }, responseExample: one(exampleCustomer),
  },
  {
    id: "getCustomer", method: "get", path: "/api/v1/customers/{id}", scope: "customers:read", summary: "Get a customer",
    description: "One customer.", pathParam: idParam("customer"),
    success: { status: 200, schema: oneOf(customerSchema), description: "The customer." },
    errors: [notFound("customer_not_found", "customer")], responseExample: one(exampleCustomer),
  },
];

/** The shared error codes every call can return. */
export const sharedErrors = [
  { status: 400, code: "validation_error", description: "A field is missing or wrong. `fieldErrors` names each one. Other 400 codes: `invalid_json`, `invalid_cursor`, `invalid_idempotency_key`." },
  { status: 401, code: "invalid_api_key", description: "The key is missing, wrong, revoked or expired." },
  { status: 403, code: "insufficient_scope", description: "The key lacks the scope this call needs. A test key that tries to write gets `test_key_read_only`." },
  { status: 413, code: "request_too_large", description: "The body is over 16 KB." },
  { status: 415, code: "unsupported_media_type", description: "Send `Content-Type: application/json`." },
  { status: 429, code: "rate_limited", description: "More than 600 requests in a minute for this key. Wait for `Retry-After` seconds." },
] as const;
