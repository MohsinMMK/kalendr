import { newFieldId, type FormField, type FormFieldType } from "@/lib/booking-forms";
import {
  emptyPeopleRule, findUnreachable, routingDraftSchema, routingLimits,
  type Destination, type DestinationType, type PeopleRule, type Route, type RoutingBuilderOptions, type RoutingDraft, type RoutingFormView, type RoutingWarning,
} from "@/lib/routing-forms";

import { newCondition, retarget } from "../booking-form-rules";

/**
 * The builder's working copy. It can be half-finished (a service not picked yet, a blank question) so people can save their
 * place in their head while typing; `validate` says what the server would refuse, in the words of the form.
 */
export interface WorkingDraft {
  name: string;
  slug: string;
  intro: string;
  questions: FormField[];
  routes: Route[];
  fallback: Destination;
}

/** Question types a routing form cannot ask: a customer answers every routing question themselves, in the form. */
export const unsupportedTypes: readonly FormFieldType[] = ["consent", "emails"];

export function defaultDestination(type: DestinationType, options: Pick<RoutingBuilderOptions, "services"> | null): Destination {
  if (type === "external") return { type: "external", url: "https://" };
  if (type === "message") return { type: "message", title: "", body: "" };
  const service = options?.services.find((entry) => entry.active && !entry.hidden) ?? options?.services.find((entry) => entry.active);
  return { type: "service", serviceId: service?.id ?? "", people: { ...emptyPeopleRule } };
}

export function blankQuestion(existing: readonly FormField[]): FormField {
  return { id: newFieldId(existing), type: "short_text", label: "", required: true };
}

export function blankDraft(options: RoutingBuilderOptions | null): WorkingDraft {
  return { name: "", slug: "", intro: "", questions: [blankQuestion([])], routes: [], fallback: defaultDestination("service", options) };
}

export function blankRoute(options: RoutingBuilderOptions | null, number: number): Route {
  return { id: `r_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`, name: `Route ${number}`, conditions: [], destination: defaultDestination("service", options) };
}

export function draftFromForm(form: Pick<RoutingFormView, "name" | "slug" | "intro" | "definition">): WorkingDraft {
  return structuredClone({ name: form.name, slug: form.slug, intro: form.intro, questions: form.definition.questions, routes: form.definition.routes, fallback: form.definition.fallback });
}

/** What is sent: blank link names dropped, the rest trimmed by the server's own schema. */
export function toDraftInput(draft: WorkingDraft): unknown {
  const questions = draft.questions.map((field) => {
    if (field.prefillKey !== undefined && field.prefillKey.trim() === "") {
      const { prefillKey, lockWhenPrefilled, ...rest } = field;
      void prefillKey; void lockWhenPrefilled;
      return rest;
    }
    return field;
  });
  return { name: draft.name, slug: draft.slug, intro: draft.intro, definition: { questions, routes: draft.routes, fallback: draft.fallback } };
}

export interface Validation {
  draft: RoutingDraft | null;
  /** Messages by path in the builder's own vocabulary: `name`, `fields.0.label`, `routes.1.conditions.0.value`, `fallback.url`. */
  errors: Record<string, string>;
  first: string;
}

function builderPath(path: ReadonlyArray<PropertyKey>): string {
  const parts = path.map(String);
  if (parts[0] === "definition") parts.shift();
  if (parts[0] === "questions") parts[0] = "fields";
  return parts.join(".");
}

export function validate(draft: WorkingDraft): Validation {
  const result = routingDraftSchema.safeParse(toDraftInput(draft));
  if (result.success) return { draft: result.data, errors: {}, first: "" };
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) errors[builderPath(issue.path)] ??= issue.message;
  const [issue] = result.error.issues;
  return { draft: null, errors, first: issue ? issue.message : "Check the form and try again." };
}

export function sameDraft(a: WorkingDraft, b: WorkingDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function moveItem<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const target = index + by;
  if (target < 0 || target >= list.length) return [...list];
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** Drops route conditions and people filters that look at a removed question. Says how many places lost one. */
export function withoutRouteRefsTo(routes: readonly Route[], fieldId: string): { routes: Route[]; changed: number } {
  let changed = 0;
  const next = routes.map((route) => {
    const conditions = route.conditions.filter((condition) => condition.fieldId !== fieldId);
    let destination = route.destination;
    if (destination.type === "service") {
      const filters = destination.people.filters.filter((filter) => !(filter.source.type === "question" && filter.source.fieldId === fieldId));
      if (filters.length !== destination.people.filters.length) destination = { ...destination, people: { ...destination.people, filters } };
    }
    if (conditions.length !== route.conditions.length || destination !== route.destination) { changed += 1; return { ...route, conditions, destination }; }
    return route;
  });
  return { routes: next, changed };
}

/** A question changed type: route conditions on it keep what still makes sense, and get a fresh value otherwise. */
export function retargetRouteConditions(routes: readonly Route[], field: FormField): Route[] {
  return routes.map((route) => (route.conditions.some((condition) => condition.fieldId === field.id)
    ? { ...route, conditions: route.conditions.map((condition) => (condition.fieldId === field.id ? retarget(condition, field) : condition)) }
    : route));
}

export function newRouteCondition(questions: readonly FormField[]) {
  const source = questions.filter((field) => !field.hidden)[0];
  return source ? newCondition(source) : null;
}

export function peopleOf(destination: Destination): PeopleRule {
  return destination.type === "service" ? destination.people : emptyPeopleRule;
}

/** Warnings worth showing right now. Before a save the server's list is out of date, so only the instant checks count. */
export function currentWarnings(draft: WorkingDraft, server: readonly RoutingWarning[], dirty: boolean): RoutingWarning[] {
  let local: RoutingWarning[] = [];
  try {
    local = draft.routes.length > 0 && draft.questions.length > 0 ? findUnreachable({ questions: draft.questions, routes: draft.routes, fallback: draft.fallback }) : [];
  } catch {
    local = [];
  }
  const merged = dirty ? local : [...local, ...server.filter((warning) => warning.kind === "service_unavailable" || warning.kind === "no_fallback_people")];
  const seen = new Set<string>();
  return merged.filter((warning) => {
    const key = `${warning.kind}:${warning.routeId}:${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const canAddRoute = (draft: WorkingDraft) => draft.routes.length < routingLimits.routes;

export function publicAddress(businessSlug: string, slug: string, origin = ""): string {
  return `${origin}/f/${businessSlug}/${slug || "your-address"}`;
}

export function slugFromName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, routingLimits.slug);
}
