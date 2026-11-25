import "server-only";

import type { ToolSet } from "ai";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { withTenant } from "@/db/client";
import { normalizeContact } from "@/lib/patient-contact";

import { ApiError } from "../api-error";
import { errorSummary, logger } from "../logger";
import { listAvailabilityDetailed } from "../appointment-repository";
import { hitRateLimit } from "../rate-limit";
import { assistantCanBook, catalogFor, formatWhen, proposeBooking, proposeCancel, proposeReschedule } from "./actions";
import { fail, handoffReasons, ok, type ToolContext, type ToolResult } from "./context";
import { aiTool } from "./ai-tools";
import { MAX_TOOL_CALLS_PER_TURN } from "./guardrails";
import type { LlmTool } from "./model";
import { asDate, rememberShown } from "./store";
import { sendVerificationCode } from "./verify";

/**
 * The assistant's tools (feature 30). The model can do only what these allow. None takes a business or tenant: the server binds
 * those. Every input is checked with zod before anything runs, and a bad one comes back to the model as a plain error, never as an
 * exception. The tool list is the same for every conversation, so the cached prompt prefix never changes; what a tool may do right
 * now (is the customer verified, was this booking shown) is decided inside it, in code.
 */

const idSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
const isoSchema = z.iso.datetime({ offset: true });
const nameSchema = z.string().trim().min(1).max(80);

const schemas = {
  list_services: z.object({}).strict(),
  list_staff: z.object({ serviceId: idSchema.optional().describe("Only people who offer this service.") }).strict(),
  find_times: z.object({
    serviceId: idSchema,
    from: isoSchema.optional().describe("Start of the window, with a time zone offset. Defaults to now."),
    to: isoSchema.optional().describe("End of the window. At most 14 days after from. Defaults to 7 days."),
    personId: idSchema.optional().describe("Only this person's times. Leave out for anyone."),
  }).strict(),
  get_business_info: z.object({}).strict(),
  hold_and_book: z.object({
    serviceId: idSchema,
    personId: idSchema.describe("The personId of a time returned by find_times."),
    startsAt: isoSchema.describe("The startsAt of a time returned by find_times, copied exactly."),
    firstName: nameSchema.optional().describe("Needed on the website chat. On WhatsApp and text the system already knows it."),
    lastName: nameSchema.optional(),
    phone: z.string().trim().min(8).max(24).optional().describe("Needed on the website chat."),
  }).strict(),
  request_verification_code: z.object({ phone: z.string().trim().min(8).max(24) }).strict(),
  find_my_bookings: z.object({}).strict(),
  reschedule: z.object({ appointmentId: idSchema, newStartsAt: isoSchema, personId: idSchema.optional() }).strict(),
  cancel: z.object({ appointmentId: idSchema }).strict(),
  hand_to_person: z.object({
    reason: z.enum(handoffReasons),
    summary: z.string().trim().min(3).max(400).describe("One or two sentences for the staff member: what the customer wants and what has happened so far."),
  }).strict(),
} as const;

export type ToolName = keyof typeof schemas;

const descriptions: Record<ToolName, string> = {
  list_services: "List the services the business offers, with length, price and which people offer each. Call this before talking about services or finding times.",
  list_staff: "List the people who take bookings, optionally only those who offer one service.",
  find_times: "Find real free times for a service. Times are returned in the business's time zone. Offer only times this returns, and never invent one.",
  get_business_info: "Get the business's name, phone, address, time zone and the facts its owner wrote. Use it for questions about the business.",
  hold_and_book: "Propose a booking for a time returned by find_times. This does NOT book: it holds the time and shows the customer a Confirm button. Needs the customer's name and phone. After calling it, tell the customer the details and ask them to confirm.",
  request_verification_code: "Website chat only. Send a one-time code to the customer's phone so they can prove it is theirs before you look at or change their bookings. The customer types the code into a separate box. Never ask them to type it in chat.",
  find_my_bookings: "List the customer's own upcoming bookings. Works only after their phone is verified.",
  reschedule: "Propose moving one of the customer's own bookings (an id from find_my_bookings) to a time returned by find_times. Does NOT move it until the customer confirms.",
  cancel: "Propose cancelling one of the customer's own bookings (an id from find_my_bookings). Does NOT cancel it until the customer confirms.",
  hand_to_person: "Pass the conversation to the team. Use when the customer asks for a person, is upset, you could not help after two tries, or it is about advice or an emergency. You stop replying after this.",
};

const order: readonly ToolName[] = ["list_services", "list_staff", "find_times", "get_business_info", "hold_and_book", "request_verification_code", "find_my_bookings", "reschedule", "cancel", "hand_to_person"];

/** A tool's input schema for the model: the zod schema as JSON Schema, without the `$schema` marker. */
function toolInputSchema(schema: z.ZodType): Record<string, unknown> {
  const full: Record<string, unknown> = { ...z.toJSONSchema(schema) };
  delete full.$schema;
  return full;
}

/** The same list, in the same order, for every conversation. */
export function assistantTools(): LlmTool[] {
  return order.map((name) => {
    return { name, description: descriptions[name], input_schema: toolInputSchema(schemas[name]) };
  });
}

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(schemas, name);
}

const MAX_TIMES = 12;
const DAY_MS = 86_400_000;

async function listServices(context: ToolContext): Promise<ToolResult> {
  const catalog = await catalogFor(context);
  return ok({
    services: catalog.services.filter((service) => service.isActive !== false && service.visibility !== "hidden").map((service) => ({
      id: service.id, name: service.name, description: service.description.slice(0, 200), minutes: service.durationMinutes,
      price: service.priceLabel ?? null, personIds: service.practitionerIds, bookableInChat: assistantCanBook(service),
    })),
  });
}

async function listStaff(context: ToolContext, input: z.infer<typeof schemas.list_staff>): Promise<ToolResult> {
  const catalog = await catalogFor(context);
  const service = input.serviceId ? catalog.services.find((entry) => entry.id === input.serviceId) : undefined;
  if (input.serviceId && !service) return fail("No such service. Call list_services.");
  return ok({
    people: catalog.practitioners.filter((person) => person.isActive !== false && (!service || service.practitionerIds.includes(person.id)))
      .map((person) => ({ id: person.id, name: person.name, title: person.title, specialty: person.specialty })),
  });
}

async function findTimes(context: ToolContext, input: z.infer<typeof schemas.find_times>): Promise<ToolResult> {
  const catalog = await catalogFor(context);
  const service = catalog.services.find((entry) => entry.id === input.serviceId && entry.isActive !== false);
  if (!service) return fail("No such service. Call list_services.");
  const places = catalog.locations.filter((place) => place.isActive !== false && (service.locationIds.length === 0 || service.locationIds.includes(place.id)));
  const place = places[0];
  if (!place) return fail("This service has no place to book.");
  const timeZone = place.timezone || catalog.clinic.timezone;
  const now = context.now;
  const requestedFrom = input.from ? new Date(input.from) : now;
  const from = requestedFrom.getTime() < now.getTime() ? now : requestedFrom;
  const to = input.to ? new Date(input.to) : new Date(from.getTime() + 7 * DAY_MS);
  if (to <= from) return fail("`to` must be after `from`.");
  if (to.getTime() - from.getTime() > 14 * DAY_MS) return fail("Ask for at most 14 days at a time.");
  const listing = await listAvailabilityDetailed({
    clinicSlug: context.slug, locationId: place.id, serviceId: service.id, practitionerId: input.personId ?? "first_available",
    from: from.toISOString(), to: to.toISOString(),
  });
  const names = new Map(catalog.practitioners.map((person) => [person.id, person.name]));
  // A spread across the window beats the first twelve of one morning.
  const slots = listing.slots;
  const step = Math.max(1, Math.ceil(slots.length / MAX_TIMES));
  const picked = slots.filter((_, index) => index % step === 0).slice(0, MAX_TIMES);
  return ok({
    timeZone,
    times: picked.map((slot) => ({ startsAt: slot.startsAt, when: formatWhen(slot.startsAt, timeZone), personId: slot.practitionerId, personName: names.get(slot.practitionerId) ?? null })),
    moreAvailable: slots.length > picked.length,
    bookableInChat: assistantCanBook(service),
    ...(assistantCanBook(service) ? {} : { note: `This service can't be booked in chat. Give the customer the booking page: ${context.bookingLink}` }),
  });
}

async function businessInfo(context: ToolContext): Promise<ToolResult> {
  const catalog = await catalogFor(context);
  return ok({
    name: catalog.clinic.name, phone: catalog.clinic.phone || null, timeZone: catalog.clinic.timezone, about: catalog.clinic.about ?? null, bookingPage: context.bookingLink,
    places: catalog.locations.filter((place) => place.isActive !== false).map((place) => ({ name: place.name, address: `${place.address}, ${place.city}`.replace(/^, |, $/g, ""), accessibleEntrance: place.accessibleEntrance })),
  });
}

async function holdAndBook(context: ToolContext, input: z.infer<typeof schemas.hold_and_book>): Promise<ToolResult> {
  // On WhatsApp and text the number is the one writing, and the record behind it supplies the name: the model's own values are ignored.
  const customer = context.channelCustomer;
  const firstName = customer ? customer.firstName : input.firstName;
  const lastName = customer ? customer.lastName : input.lastName;
  const rawPhone = customer ? customer.phone : input.phone;
  if (!firstName || (!customer && !lastName)) return fail("Ask the customer for their first and last name first.");
  if (!rawPhone || !normalizeContact("phone", rawPhone)) return fail("Ask the customer for a phone number we can reach them on.");
  const proposal = await proposeBooking(context, { serviceId: input.serviceId, personId: input.personId, startsAt: input.startsAt, firstName, lastName: lastName ?? "", phone: rawPhone, ...(customer ? { email: customer.email } : {}) });
  context.state.proposal = { id: proposal.proposalId, kind: "book", summary: proposal.summary, expiresAt: new Date(context.now.getTime() + 15 * 60_000) };
  return ok({
    status: "awaiting_customer_confirmation", summary: proposal.summary,
    tell_the_customer: "Nothing is booked yet. Say the details, then say that by confirming they accept the privacy notice and agree to reminders by text or WhatsApp. Ask them to tap Confirm or reply yes.",
  });
}

async function requestCode(context: ToolContext, input: z.infer<typeof schemas.request_verification_code>): Promise<ToolResult> {
  if (context.channel !== "web") return fail("This customer is already identified by their number. Use find_my_bookings.");
  await sendVerificationCode(context, input.phone);
  context.state.awaitingCode = true;
  return ok({ status: "code_requested", tell_the_customer: "If that number has bookings here, a code was sent by text. Ask them to enter it in the code box. Do not say whether the number was found." });
}

async function findMyBookings(context: ToolContext): Promise<ToolResult> {
  const verified = context.conversation.verifiedPatientIds;
  if (!verified.length) return fail(context.channel === "web" ? "The customer has not verified their phone. Use request_verification_code first." : "No customer record is linked to this chat.");
  const ids = verified;
  const rows = await withTenant(context.tenantId, (transaction) => transaction.execute<{ id: string; service_name: string; practitioner_name: string; starts_at: Date | string; status: string; timezone: string }>(sql`
    select appointment.id, service.name as service_name, practitioner.name as practitioner_name, appointment.starts_at, appointment.status, location.timezone
    from appointments as appointment
    join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
    join practitioners as practitioner on practitioner.tenant_id = appointment.tenant_id and practitioner.id = appointment.practitioner_id
    join locations as location on location.tenant_id = appointment.tenant_id and location.id = appointment.location_id
    where appointment.tenant_id = ${context.tenantId} and appointment.patient_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      and appointment.status in ('booked', 'requested') and appointment.starts_at > now()
    order by appointment.starts_at limit 10
  `));
  await withTenant(context.tenantId, (transaction) => rememberShown(transaction, context.tenantId, context.conversation.id, rows.map((row) => row.id)));
  context.conversation.shownAppointmentIds = rows.map((row) => row.id);
  return ok({ bookings: rows.map((row) => ({ id: row.id, service: row.service_name, person: row.practitioner_name, when: formatWhen(row.starts_at, row.timezone), startsAt: asDate(row.starts_at).toISOString(), status: row.status })) });
}

async function changeBooking(context: ToolContext, kind: "cancel" | "reschedule", input: { appointmentId: string; newStartsAt?: string; personId?: string | undefined }): Promise<ToolResult> {
  if (!context.conversation.verifiedPatientIds.length) return fail(context.channel === "web" ? "The customer has not verified their phone. Use request_verification_code first." : "No customer record is linked to this chat.");
  const proposal = kind === "cancel"
    ? await proposeCancel(context, input.appointmentId)
    : await proposeReschedule(context, { appointmentId: input.appointmentId, newStartsAt: input.newStartsAt ?? "", personId: input.personId });
  context.state.proposal = { id: proposal.proposalId, kind, summary: proposal.summary, expiresAt: new Date(context.now.getTime() + 15 * 60_000) };
  return ok({ status: "awaiting_customer_confirmation", summary: proposal.summary, tell_the_customer: "Nothing has changed yet. Say the change in plain words and ask them to tap Confirm or reply yes." });
}

async function handToPerson(context: ToolContext, input: z.infer<typeof schemas.hand_to_person>): Promise<ToolResult> {
  context.state.handoff = { reason: input.reason, summary: input.summary };
  return ok({ status: "handed_off", tell_the_customer: "The team will take over. Say so in one short sentence and stop." });
}

/** Runs one tool call the model asked for. Never throws: a refusal is a result the model reads. */
export async function runTool(context: ToolContext, name: string, rawInput: unknown): Promise<ToolResult> {
  if (!isToolName(name)) return fail("That tool does not exist.");
  context.state.toolCalls += 1;
  const parsed = schemas[name].safeParse(rawInput ?? {});
  if (!parsed.success) return fail(`Invalid input: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`).join("; ").slice(0, 300)}`);
  try {
    const limited = await hitRateLimit("assistant.conversation", `tool:${context.conversation.id}`);
    if (!limited.allowed) return fail("Too many requests. Ask the customer to wait a moment.");
    switch (name) {
      case "list_services": return await listServices(context);
      case "list_staff": return await listStaff(context, schemas.list_staff.parse(parsed.data));
      case "find_times": return await findTimes(context, schemas.find_times.parse(parsed.data));
      case "get_business_info": return await businessInfo(context);
      case "hold_and_book": return await holdAndBook(context, schemas.hold_and_book.parse(parsed.data));
      case "request_verification_code": return await requestCode(context, schemas.request_verification_code.parse(parsed.data));
      case "find_my_bookings": return await findMyBookings(context);
      case "reschedule": { const value = schemas.reschedule.parse(parsed.data); return await changeBooking(context, "reschedule", value); }
      case "cancel": { const value = schemas.cancel.parse(parsed.data); return await changeBooking(context, "cancel", value); }
      case "hand_to_person": return await handToPerson(context, schemas.hand_to_person.parse(parsed.data));
    }
  } catch (error: unknown) {
    // Only an ApiError's own plain sentence reaches the model. Anything else is ours to log, not to show.
    if (error instanceof ApiError) return fail(error.message);
    // The tool and the kind of error only: the error object can carry the query's values.
    logger().error({ event: "assistant.tool_failed", tool: name, ...errorSummary(error) }, "An assistant tool failed");
    return fail("That didn't work. Offer the booking page instead.");
  }
}

/**
 * The same tools as AI SDK tools for one turn. Each call goes through `runTool`, so validation, the rate limit and the refusals are
 * the same code the old loop used. Calls run one at a time, in the order the model made them: they share the turn's state (one
 * waiting proposal, one handoff, the call count), and six calls in a step must not race. Past the cap a call is answered with a
 * plain error, never run.
 */
export function assistantAiTools(context: ToolContext): ToolSet {
  const tools: ToolSet = {};
  let queue: Promise<unknown> = Promise.resolve();
  for (const name of order) {
    tools[name] = aiTool({
      description: descriptions[name],
      inputSchema: schemas[name],
      run: (input) => {
        const result = queue.then(async (): Promise<ToolResult> => {
          if (context.state.toolCalls >= MAX_TOOL_CALLS_PER_TURN) return fail("Too many tool calls this turn. Answer with what you have.");
          return runTool(context, name, input);
        });
        queue = result.catch(() => undefined);
        return result;
      },
    });
  }
  return tools;
}
