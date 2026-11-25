import { z } from "zod";

import {
  answerWords,
  conditionHolds,
  conditionSchema,
  formAnswersSchema,
  formFieldSchema,
  hasOptions,
  isFieldVisible,
  multiChoiceTypes,
  singleChoiceTypes,
  type FieldCondition,
  type FormAnswers,
  type FormField,
} from "./booking-forms";

/**
 * Routing forms (feature 46): a few questions, then the right service and the right person. Everything here is plain
 * data and pure functions, with no database, so the builder, the public form, the preview and the server all run the
 * same rules. Questions are booking-form questions (feature 40) and conditions are booking-form conditions.
 */

export const routingLimits = { questions: 12, routes: 25, people: 100, name: 120, slug: 60, message: 600, url: 500 } as const;

export const updateFormSchema = z.strictObject({ draft: z.lazy(() => routingDraftSchema), expectedRevision: z.number().int().min(1) });
export const revisionSchema = z.strictObject({ expectedRevision: z.number().int().min(1) });

export const routingStatuses = ["draft", "live"] as const;
export type RoutingStatus = (typeof routingStatuses)[number];

export const slugSchema = z.string().trim().toLowerCase().min(2).max(routingLimits.slug).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and dashes.");

const idSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);

// ---- Who can be offered ---------------------------------------------------------------------------------------------

export const attributeOperators = ["equals", "includes", "one_of", "at_least"] as const;
export type AttributeOperator = (typeof attributeOperators)[number];
export const attributeOperatorLabels: Record<AttributeOperator, string> = {
  equals: "is",
  includes: "includes",
  one_of: "is one of",
  at_least: "is at least",
};

/** Where the value a person is compared with comes from: the customer's answer to a question, or a fixed value. */
const filterSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("question"), fieldId: z.string().trim().min(1).max(40) }),
  z.strictObject({ type: z.literal("value"), value: z.union([z.string().trim().min(1).max(300), z.number().finite(), z.array(z.string().trim().min(1).max(300)).min(1).max(20)]) }),
]);
export type FilterSource = z.infer<typeof filterSourceSchema>;

export const peopleFilterSchema = z.strictObject({
  attributeId: idSchema,
  operator: z.enum(attributeOperators),
  source: filterSourceSchema,
});
export type PeopleFilter = z.infer<typeof peopleFilterSchema>;

/** "People whose Seniority is Senior count double." Feeds feature 20's fair-share step as a multiplier on their weight. */
export const peopleWeightSchema = z.strictObject({
  attributeId: idSchema,
  value: z.string().trim().min(1).max(300),
  multiplier: z.number().int().min(1).max(10),
});
export type PeopleWeight = z.infer<typeof peopleWeightSchema>;

export const peopleRuleSchema = z.strictObject({
  /** Only these people, when set. Everyone who offers the service otherwise. */
  personIds: z.array(idSchema).max(routingLimits.people).default([]),
  filters: z.array(peopleFilterSchema).max(5).default([]),
  weights: z.array(peopleWeightSchema).max(10).default([]),
});
export type PeopleRule = z.infer<typeof peopleRuleSchema>;

export const emptyPeopleRule: PeopleRule = { personIds: [], filters: [], weights: [] };

// ---- Destinations and routes ----------------------------------------------------------------------------------------

const externalUrlSchema = z.string().trim().max(routingLimits.url).refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "Use a web address that starts with https://.");

export const destinationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("service"), serviceId: idSchema, people: peopleRuleSchema.default(emptyPeopleRule) }),
  z.strictObject({ type: z.literal("external"), url: externalUrlSchema }),
  z.strictObject({ type: z.literal("message"), title: z.string().trim().min(1, "Give the message a heading.").max(120), body: z.string().trim().min(1, "Write the message.").max(routingLimits.message) }),
]);
export type Destination = z.infer<typeof destinationSchema>;
export type DestinationType = Destination["type"];

export const destinationLabels: Record<DestinationType, string> = {
  service: "Book a service",
  external: "Go to another website",
  message: "Show a message",
};

export const routeSchema = z.strictObject({
  id: idSchema,
  name: z.string().trim().min(1, "Name the route.").max(routingLimits.name),
  /** All must hold. None means "everyone who reaches this route". */
  conditions: z.array(conditionSchema).max(6),
  destination: destinationSchema,
});
export type Route = z.infer<typeof routeSchema>;

export const FALLBACK_ID = "fallback";

export const routingDefinitionSchema = z.strictObject({
  questions: z.array(formFieldSchema).min(1, "Add at least one question.").max(routingLimits.questions),
  routes: z.array(routeSchema).max(routingLimits.routes),
  fallback: destinationSchema,
}).superRefine((definition, context) => {
  const ids = new Set<string>();
  const keys = new Set<string>();
  definition.questions.forEach((field, index) => {
    if (ids.has(field.id)) context.addIssue({ code: "custom", path: ["questions", index, "id"], message: "Two questions share the same id." });
    if (field.hidden || field.type === "emails" || field.type === "consent") {
      context.addIssue({ code: "custom", path: ["questions", index, "type"], message: "Routing questions are plain questions the customer answers." });
    }
    for (const [conditionIndex, condition] of (field.showWhen ?? []).entries()) {
      if (!ids.has(condition.fieldId)) context.addIssue({ code: "custom", path: ["questions", index, "showWhen", conditionIndex, "fieldId"], message: "A question can only depend on one that comes before it." });
    }
    if (field.prefillKey) {
      if (keys.has(field.prefillKey.toLowerCase())) context.addIssue({ code: "custom", path: ["questions", index, "prefillKey"], message: "Two questions use the same booking link name." });
      keys.add(field.prefillKey.toLowerCase());
    }
    ids.add(field.id);
  });
  const routeIds = new Set<string>();
  definition.routes.forEach((route, index) => {
    if (route.id === FALLBACK_ID || routeIds.has(route.id)) context.addIssue({ code: "custom", path: ["routes", index, "id"], message: "Two routes share the same id." });
    routeIds.add(route.id);
    route.conditions.forEach((condition, conditionIndex) => {
      if (!ids.has(condition.fieldId)) context.addIssue({ code: "custom", path: ["routes", index, "conditions", conditionIndex, "fieldId"], message: "Choose one of the form's questions." });
    });
    for (const [filterIndex, filter] of (route.destination.type === "service" ? route.destination.people.filters : []).entries()) {
      if (filter.source.type === "question" && !ids.has(filter.source.fieldId)) {
        context.addIssue({ code: "custom", path: ["routes", index, "destination", "people", "filters", filterIndex], message: "Choose one of the form's questions." });
      }
    }
  });
  if (definition.fallback.type === "service" && definition.fallback.people.filters.some((filter) => filter.source.type === "question")) {
    context.addIssue({ code: "custom", path: ["fallback"], message: "The fallback cannot depend on an answer. Pick people directly." });
  }
});
export type RoutingDefinition = z.infer<typeof routingDefinitionSchema>;

export const routingDraftSchema = z.strictObject({
  name: z.string().trim().min(1, "Give the form a name.").max(routingLimits.name),
  slug: slugSchema,
  intro: z.string().trim().max(300).default(""),
  definition: routingDefinitionSchema,
});
export type RoutingDraft = z.infer<typeof routingDraftSchema>;
export type RoutingDraftInput = z.input<typeof routingDraftSchema>;

// ---- What staff and customers see -----------------------------------------------------------------------------------

export interface RoutingFormSummary {
  id: string;
  key: string;
  name: string;
  slug: string;
  status: RoutingStatus;
  version: number;
  routeCount: number;
  /** Responses in the last 30 days. */
  responses30d: number;
  updatedAt: string;
}

export interface RoutingFormView extends RoutingDraft {
  id: string;
  key: string;
  status: RoutingStatus;
  version: number;
  /** Counts saves, so two people editing at once are caught. Send it back with the next save. */
  revision: number;
  /** True when the saved form differs from the version customers see (a live form edited since). */
  hasUnpublishedChanges: boolean;
  updatedAt: string;
}

export interface RoutingFormDetail {
  form: RoutingFormView;
  warnings: RoutingWarning[];
}

/** What the builder offers to pick from: services, people and the attributes set on them. */
export interface RoutingBuilderOptions {
  services: Array<{ id: string; name: string; active: boolean; hidden: boolean }>;
  people: Array<{ id: string; name: string }>;
  attributes: Array<{ id: string; name: string; kind: "text" | "single" | "multiple" | "number"; options: string[] }>;
  /** Link names the business's booking questions already use, so a routing question can share one and fill it in. */
  bookingKeys: string[];
}

/** What a customer's browser needs to draw the form. Routes and people stay on the server. */
export interface PublicRoutingForm {
  name: string;
  intro: string;
  questions: FormField[];
  businessName: string;
}

export const openResponseSchema = z.strictObject({});

export const submitAnswersSchema = z.strictObject({
  answers: formAnswersSchema,
  /** From the page that opened the form; leave out when posting from your own website. */
  responseToken: z.string().trim().min(20).max(200).regex(/^[A-Za-z0-9_-]+$/).optional(),
});
export type SubmitAnswersInput = z.infer<typeof submitAnswersSchema>;

/** Where the customer goes next. Never says who was matched or why. */
export type RoutingOutcome =
  | { type: "booking"; url: string }
  | { type: "external"; url: string }
  | { type: "message"; title: string; body: string };

// ---- Evaluating ------------------------------------------------------------------------------------------------------

export interface ConditionTrace {
  fieldId: string;
  label: string;
  operator: FieldCondition["operator"];
  /** What the owner asked for. Never what the customer typed. */
  expected: string | string[];
  passed: boolean;
}

export interface RouteTrace {
  routeId: string;
  name: string;
  matched: boolean;
  conditions: ConditionTrace[];
  /** Matched, but nobody who offers the service fits the people rule, so the next route was tried. */
  skipped?: "no_people";
}

export interface PersonTrace {
  personId: string;
  name: string;
  passed: boolean;
  /** Plain reasons, from the owner's own rules: "Language includes Tamil". */
  reasons: string[];
  multiplier: number;
}

export interface RoutingTrace {
  routes: RouteTrace[];
  matchedRouteId: string;
  matchedRouteName: string;
  /** Why this person got the booking, added when the booking is made. */
  assignment?: { personId: string; name: string; why: string };
  people: PersonTrace[];
}

export interface DirectoryPerson {
  id: string;
  name: string;
  attributes: Record<string, string | number | string[]>;
}

export interface AttributeInfo {
  id: string;
  name: string;
}

export interface Resolution {
  route: Route | null;
  destination: Destination;
  trace: RoutingTrace;
  /** For a service destination: who may be offered, with weight multipliers. Empty means "nobody to route to". */
  candidateIds: string[];
  multipliers: Record<string, number>;
}

/** Answers with those of questions hidden by their conditions removed, so a hidden answer can never steer a route. */
export function visibleAnswers(questions: readonly FormField[], answers: FormAnswers): FormAnswers {
  const next: FormAnswers = {};
  for (const field of questions) {
    const value = answers[field.id];
    if (value !== undefined && isFieldVisible(field, answers, questions)) next[field.id] = value;
  }
  return next;
}

function traceConditions(route: Route, questions: readonly FormField[], answers: FormAnswers): ConditionTrace[] {
  return route.conditions.map((condition) => ({
    fieldId: condition.fieldId,
    label: questions.find((field) => field.id === condition.fieldId)?.label ?? "A removed question",
    operator: condition.operator,
    expected: condition.value,
    passed: conditionHolds(condition, answers),
  }));
}

function words(value: string | number | string[] | undefined): string[] {
  if (value === undefined) return [];
  if (typeof value === "number") return [String(value)];
  return (Array.isArray(value) ? value : [value]).map((word) => word.trim().toLowerCase()).filter(Boolean);
}

function sourceWords(source: FilterSource, answers: FormAnswers): string[] {
  return source.type === "value" ? words(source.value) : words(answerWords(answers[source.fieldId]));
}

/** Does this person's attribute fit the filter? A person with no value for the attribute never fits. */
export function personFits(person: DirectoryPerson, filter: PeopleFilter, answers: FormAnswers): boolean {
  const mine = person.attributes[filter.attributeId];
  if (mine === undefined) return false;
  const wanted = sourceWords(filter.source, answers);
  // A question the customer left unanswered cannot narrow anyone down: nobody is picked on a guess.
  if (wanted.length === 0) return false;
  const have = words(mine);
  switch (filter.operator) {
    case "equals": return have.length === 1 && wanted.some((word) => word === have[0]);
    case "includes":
    case "one_of": return wanted.some((word) => have.includes(word));
    case "at_least": {
      const mineNumber = typeof mine === "number" ? mine : Number(have[0]);
      const target = Number(wanted[0]);
      return Number.isFinite(mineNumber) && Number.isFinite(target) && mineNumber >= target;
    }
  }
}

function filterText(filter: PeopleFilter, attributes: ReadonlyMap<string, string>, questions: readonly FormField[]): string {
  const name = attributes.get(filter.attributeId) ?? "An attribute";
  const target = filter.source.type === "question"
    ? `the answer to “${questions.find((field) => field.id === (filter.source as { fieldId: string }).fieldId)?.label ?? "a removed question"}”`
    : [filter.source.value].flat().join(", ");
  return `${name} ${attributeOperatorLabels[filter.operator]} ${target}`;
}

/**
 * Narrows the people who offer a service by the route's people rule, and works out each one's weight multiplier. Returns
 * everyone considered with the reasons, so the trace can say why a person was or was not offered.
 */
export function selectPeople(
  pool: readonly DirectoryPerson[],
  rule: PeopleRule,
  answers: FormAnswers,
  context: { questions: readonly FormField[]; attributes: readonly AttributeInfo[] },
): { people: PersonTrace[]; candidateIds: string[]; multipliers: Record<string, number> } {
  const attributeNames = new Map(context.attributes.map((attribute) => [attribute.id, attribute.name]));
  const allowed = rule.personIds.length > 0 ? new Set(rule.personIds) : null;
  const people: PersonTrace[] = [];
  const multipliers: Record<string, number> = {};
  for (const person of pool) {
    const reasons: string[] = [];
    let passed = true;
    if (allowed && !allowed.has(person.id)) {
      passed = false;
      reasons.push("Not on the route's list of people");
    }
    for (const filter of rule.filters) {
      const fits = personFits(person, filter, answers);
      const text = filterText(filter, attributeNames, context.questions);
      reasons.push(fits ? text : `Does not match: ${text}`);
      if (!fits) passed = false;
    }
    let multiplier = 1;
    for (const weight of rule.weights) {
      const mine = person.attributes[weight.attributeId];
      if (mine !== undefined && words(mine).includes(weight.value.trim().toLowerCase())) multiplier = Math.max(multiplier, weight.multiplier);
    }
    if (passed && multiplier > 1) {
      reasons.push(`Counts ${multiplier} times: ${attributeNames.get(rule.weights.find((weight) => weight.multiplier === multiplier)?.attributeId ?? "") ?? "An attribute"} weighting`);
    }
    people.push({ personId: person.id, name: person.name, passed, reasons, multiplier });
    if (passed) multipliers[person.id] = multiplier;
  }
  return { people, candidateIds: people.filter((person) => person.passed).map((person) => person.personId), multipliers };
}

/**
 * Walks the routes in order and returns the first whose conditions hold. A service route nobody fits is passed over, so
 * a customer is never sent to a doctor who does not match what they asked for. The fallback catches the rest.
 * `directory` gives, for each service named, the people who offer it right now.
 */
export function resolveRouting(
  definition: RoutingDefinition,
  rawAnswers: FormAnswers,
  directory: ReadonlyMap<string, readonly DirectoryPerson[]>,
  attributes: readonly AttributeInfo[],
): Resolution {
  const answers = visibleAnswers(definition.questions, rawAnswers);
  const routes: RouteTrace[] = [];
  const context = { questions: definition.questions, attributes };
  for (const route of definition.routes) {
    const conditions = traceConditions(route, definition.questions, answers);
    const matched = conditions.every((condition) => condition.passed);
    const entry: RouteTrace = { routeId: route.id, name: route.name, matched, conditions };
    routes.push(entry);
    if (!matched) continue;
    if (route.destination.type !== "service") {
      return { route, destination: route.destination, trace: { routes, matchedRouteId: route.id, matchedRouteName: route.name, people: [] }, candidateIds: [], multipliers: {} };
    }
    const picked = selectPeople(directory.get(route.destination.serviceId) ?? [], route.destination.people, answers, context);
    if (picked.candidateIds.length === 0) {
      entry.skipped = "no_people";
      continue;
    }
    return { route, destination: route.destination, trace: { routes, matchedRouteId: route.id, matchedRouteName: route.name, people: picked.people }, candidateIds: picked.candidateIds, multipliers: picked.multipliers };
  }
  const fallback = definition.fallback;
  const picked = fallback.type === "service"
    ? selectPeople(directory.get(fallback.serviceId) ?? [], fallback.people, answers, context)
    : { people: [], candidateIds: [], multipliers: {} };
  return {
    route: null,
    destination: fallback,
    trace: { routes, matchedRouteId: FALLBACK_ID, matchedRouteName: "Fallback", people: picked.people },
    candidateIds: picked.candidateIds,
    multipliers: picked.multipliers,
  };
}

// ---- Builder checks --------------------------------------------------------------------------------------------------

export interface RoutingWarning {
  kind: "shadowed" | "impossible" | "service_unavailable" | "no_fallback_people";
  /** The route the warning is about, or "fallback". */
  routeId: string;
  message: string;
}

const MAX_COMBINATIONS = 20_000;

/** The answers worth trying for a question: each choice, none, and for free text only the owner's own words plus "something else". */
function candidateValues(field: FormField, conditions: readonly FieldCondition[]): Array<FormAnswers[string] | undefined> {
  if (field.type === "yes_no") return [undefined, true, false];
  if (hasOptions(field.type)) {
    const options = field.options ?? [];
    if (singleChoiceTypes.includes(field.type)) return [undefined, ...options];
    if (multiChoiceTypes.includes(field.type)) {
      const pairs: string[][] = [];
      for (let first = 0; first < options.length; first += 1) for (let second = first + 1; second < Math.min(options.length, first + 4); second += 1) pairs.push([options[first]!, options[second]!]);
      return [undefined, ...options.map((option) => [option]), ...pairs];
    }
  }
  const mentioned = conditions.flatMap((condition) => (Array.isArray(condition.value) ? condition.value : [condition.value]));
  return [undefined, ...new Set(mentioned.filter(Boolean)), "something else"];
}

/**
 * Routes that can never be reached: an earlier route holds in every case this one would, or the route's own conditions
 * can never all hold. Tries every combination of the answers the route conditions look at (capped), so a warning is
 * never raised unless it is certain; a form too large to check fully is left unwarned.
 */
export function findUnreachable(definition: RoutingDefinition): RoutingWarning[] {
  const warnings: RoutingWarning[] = [];
  const questions = definition.questions;
  const all = definition.routes.flatMap((route) => route.conditions);
  const fieldIds = [...new Set(all.map((condition) => condition.fieldId))];
  const fields = fieldIds.flatMap((id) => questions.find((field) => field.id === id) ?? []);
  const options = fields.map((field) => candidateValues(field, all.filter((condition) => condition.fieldId === field.id)));
  const total = options.reduce((product, list) => product * list.length, 1);
  const catchAll = definition.routes.findIndex((route) => route.conditions.length === 0);
  if (total > MAX_COMBINATIONS) {
    // Too many cases to try; the one certain case is an earlier route with no conditions at all.
    definition.routes.forEach((route, index) => {
      if (catchAll !== -1 && index > catchAll) warnings.push(shadowed(route, definition.routes[catchAll]!));
    });
    if (catchAll !== -1) warnings.push({ kind: "shadowed", routeId: FALLBACK_ID, message: `The fallback is never used, because “${definition.routes[catchAll]!.name}” catches everyone.` });
    return warnings;
  }
  const reachable = new Set<number>();
  let fallbackReached = false;
  const current: FormAnswers = {};
  const walk = (position: number): void => {
    if (position === fields.length) {
      const seen = visibleAnswers(questions, current);
      const first = definition.routes.findIndex((route) => route.conditions.every((condition) => conditionHolds(condition, seen)));
      if (first === -1) fallbackReached = true;
      else reachable.add(first);
      return;
    }
    const field = fields[position]!;
    for (const value of options[position]!) {
      if (value === undefined) delete current[field.id];
      else current[field.id] = value;
      walk(position + 1);
    }
    delete current[field.id];
  };
  walk(0);
  // A route first reached in some case is fine. One never first-reached is either impossible or hidden behind earlier ones.
  const possible = (route: Route): boolean => {
    let any = false;
    const probe = (position: number): void => {
      if (any) return;
      if (position === fields.length) {
        any = route.conditions.every((condition) => conditionHolds(condition, visibleAnswers(questions, current)));
        return;
      }
      const field = fields[position]!;
      for (const value of options[position]!) {
        if (value === undefined) delete current[field.id];
        else current[field.id] = value;
        probe(position + 1);
        if (any) return;
      }
      delete current[field.id];
    };
    probe(0);
    for (const field of fields) delete current[field.id];
    return any;
  };
  definition.routes.forEach((route, index) => {
    if (reachable.has(index)) return;
    if (!possible(route)) {
      warnings.push({ kind: "impossible", routeId: route.id, message: `“${route.name}” can never match: its conditions rule each other out or ask for something no one can answer.` });
      return;
    }
    const blocker = definition.routes.slice(0, index).find((earlier) => earlier.conditions.length === 0)
      ?? definition.routes.slice(0, index).find((earlier) => earlier.conditions.length > 0) ?? definition.routes[0]!;
    warnings.push(shadowed(route, blocker));
  });
  if (!fallbackReached && definition.routes.length > 0) {
    warnings.push({ kind: "shadowed", routeId: FALLBACK_ID, message: "The fallback is never used, because the routes above already catch every combination of answers." });
  }
  return warnings;
}

function shadowed(route: Route, blocker: Route): RoutingWarning {
  return { kind: "shadowed", routeId: route.id, message: `“${route.name}” can never be reached: earlier routes, such as “${blocker.name}”, already catch every case it would.` };
}

// ---- Booking link and prefill ----------------------------------------------------------------------------------------

/** Answers keyed by their shared booking-link name, so the booking page can fill the matching booking questions. */
export function prefillFromAnswers(questions: readonly FormField[], answers: FormAnswers): Record<string, string> {
  const result: Record<string, string> = {};
  const seen = visibleAnswers(questions, answers);
  for (const field of questions) {
    // The booking page reads email and phone from its own link names, so those two questions fill the contact step.
    const key = field.prefillKey ?? (field.type === "email" ? "email" : field.type === "phone" ? "phone" : undefined);
    const value = seen[field.id];
    if (!key || value === undefined || key in result) continue;
    if (typeof value === "string") result[key] = value;
    else if (typeof value === "boolean") result[key] = value ? "yes" : "no";
    else if (Array.isArray(value)) result[key] = value.join(",");
  }
  return result;
}

/** The booking page address for a routed customer. Carries only ids and an opaque token, never an answer. */
export function bookingPath(clinicSlug: string, serviceId: string, token: string): string {
  const query = new URLSearchParams({ service: serviceId, routing: token });
  return `/book/${encodeURIComponent(clinicSlug)}?${query.toString()}`;
}

/** Text a person can read for one route: "First visit? is Yes and Language includes Tamil". */
export function describeConditions(route: Route, questions: readonly FormField[]): string {
  if (route.conditions.length === 0) return "Everyone";
  const labels: Record<FieldCondition["operator"], string> = { equals: "is", not_equals: "is not", contains: "includes", one_of: "is one of" };
  return route.conditions
    .map((condition) => `${questions.find((field) => field.id === condition.fieldId)?.label ?? "A removed question"} ${labels[condition.operator]} ${[condition.value].flat().join(" or ")}`)
    .join(" and ");
}

// ---- Reports ---------------------------------------------------------------------------------------------------------

export interface RoutingReport {
  from: string;
  to: string;
  opened: number;
  answered: number;
  slotShown: number;
  booked: number;
  /** Answered, sent to a booking page, and did not book within `abandonedAfterHours`. */
  answeredNotBooked: number;
  abandonedAfterHours: number;
  perRoute: Array<{ routeId: string; name: string; responses: number; booked: number; notBooked: number }>;
  /** Answered but did not book in the 7 days before `to`. */
  answeredNotBookedLastWeek: number;
}

/** Hours after answering before a customer who has not booked counts as having left. */
export const ABANDON_AFTER_HOURS = 2;

export const reportRangeSchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
}).strict();

export const wrongAssignmentSchema = z.strictObject({
  appointmentId: idSchema,
  correctPractitionerId: idSchema.optional(),
  note: z.string().trim().max(500).optional(),
});
export type WrongAssignmentInput = z.infer<typeof wrongAssignmentSchema>;

export const wrongAssignmentStatuses = ["open", "fixed", "dismissed"] as const;
export type WrongAssignmentStatus = (typeof wrongAssignmentStatuses)[number];

export const reviewWrongAssignmentSchema = z.strictObject({
  status: z.enum(["fixed", "dismissed"]),
  expectedVersion: z.number().int().min(1),
});

export interface WrongAssignmentView {
  id: string;
  appointmentId: string;
  startsAt: string;
  serviceName: string;
  assignedName: string;
  correctName: string | null;
  note: string | null;
  routeName: string | null;
  reportedBy: string;
  status: WrongAssignmentStatus;
  version: number;
  createdAt: string;
}

export interface AppointmentRoutingView {
  formName: string;
  routeName: string;
  routedAt: string;
  trace: RoutingTrace;
  /** One-line summary shown on the booking: "Routed by: Language includes Tamil. Dr Iyer had the fewest bookings this month." */
  summary: string;
}

export const previewSchema = z.strictObject({ answers: formAnswersSchema });
export type PreviewInput = z.infer<typeof previewSchema>;

export interface PreviewResult {
  routeName: string;
  routeId: string;
  destination: Destination;
  trace: RoutingTrace;
  /** The people the booking page would offer, with the extra weight each carries. */
  offered: Array<{ personId: string; name: string; multiplier: number }>;
}

export function traceSummary(trace: RoutingTrace): string {
  const matched = trace.routes.find((route) => route.routeId === trace.matchedRouteId);
  const because = matched
    ? matched.conditions.filter((condition) => condition.passed).map((condition) => `${condition.label} ${{ equals: "=", not_equals: "≠", contains: "includes", one_of: "is one of" }[condition.operator]} ${[condition.expected].flat().join(" or ")}`)
    : [];
  const why = trace.assignment ? `${trace.assignment.name} ${trace.assignment.why}.` : "";
  const lead = because.length > 0 ? because.join(", ") : trace.matchedRouteName;
  return `Routed by: ${lead}.${why ? ` ${why}` : ""}`;
}
