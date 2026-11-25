import { describe, expect, it } from "vitest";

import type { FormField } from "./booking-forms";
import {
  FALLBACK_ID,
  bookingPath,
  describeConditions,
  findUnreachable,
  prefillFromAnswers,
  resolveRouting,
  routingDefinitionSchema,
  selectPeople,
  traceSummary,
  visibleAnswers,
  type DirectoryPerson,
  type RoutingDefinition,
} from "./routing-forms";

const attributes = [{ id: "lang", name: "Language" }, { id: "spec", name: "Speciality" }, { id: "rank", name: "Seniority" }];

const questions: FormField[] = [
  { id: "first", type: "yes_no", label: "First visit?", required: true },
  { id: "language", type: "single_choice", label: "Language?", required: true, options: ["Tamil", "Hindi", "English"], prefillKey: "language" },
  { id: "email", type: "email", label: "Email", required: false },
];

const people: DirectoryPerson[] = [
  { id: "iyer", name: "Dr Iyer", attributes: { lang: ["Tamil", "English"], rank: "Senior" } },
  { id: "shah", name: "Dr Shah", attributes: { lang: ["Hindi"], rank: "Junior" } },
  { id: "rao", name: "Dr Rao", attributes: {} },
];

const definition: RoutingDefinition = {
  questions,
  routes: [
    {
      id: "r1", name: "First-time Tamil speaker",
      conditions: [{ fieldId: "first", operator: "equals", value: "yes" }, { fieldId: "language", operator: "equals", value: "Tamil" }],
      destination: { type: "service", serviceId: "consult", people: { personIds: [], filters: [{ attributeId: "lang", operator: "includes", source: { type: "question", fieldId: "language" } }], weights: [{ attributeId: "rank", value: "Senior", multiplier: 2 }] } },
    },
    { id: "r2", name: "Follow-up", conditions: [{ fieldId: "first", operator: "equals", value: "no" }], destination: { type: "external", url: "https://example.com/follow-up" } },
  ],
  fallback: { type: "message", title: "Call us", body: "We will help you book." },
};
const directory = new Map([["consult", people]]);

describe("routing form definition", () => {
  it("accepts a valid form and rejects a condition on a later question", () => {
    expect(routingDefinitionSchema.safeParse(definition).success).toBe(true);
    const bad = { ...definition, questions: [{ ...questions[0]!, showWhen: [{ fieldId: "language", operator: "equals", value: "Tamil" }] }, questions[1]!] };
    expect(routingDefinitionSchema.safeParse(bad).success).toBe(false);
  });

  it("requires a fallback and refuses non-https external addresses", () => {
    expect(routingDefinitionSchema.safeParse({ ...definition, fallback: undefined }).success).toBe(false);
    expect(routingDefinitionSchema.safeParse({ ...definition, fallback: { type: "external", url: "javascript:alert(1)" } }).success).toBe(false);
    expect(routingDefinitionSchema.safeParse({ ...definition, fallback: { type: "external", url: "http://example.com" } }).success).toBe(false);
  });

  it("refuses hidden, consent and guest questions, and a route that names an unknown question", () => {
    expect(routingDefinitionSchema.safeParse({ ...definition, questions: [{ id: "c", type: "consent", label: "OK", required: true }] }).success).toBe(false);
    const route = { ...definition.routes[0]!, conditions: [{ fieldId: "nope", operator: "equals" as const, value: "x" }] };
    expect(routingDefinitionSchema.safeParse({ ...definition, routes: [route] }).success).toBe(false);
  });
});

describe("resolving a route", () => {
  it("sends a first-time Tamil speaker to the consultation with only Tamil-speaking doctors, the senior one counting double", () => {
    const result = resolveRouting(definition, { first: true, language: "Tamil" }, directory, attributes);
    expect(result.trace.matchedRouteId).toBe("r1");
    expect(result.destination).toMatchObject({ type: "service", serviceId: "consult" });
    expect(result.candidateIds).toEqual(["iyer"]);
    expect(result.multipliers).toEqual({ iyer: 2 });
    const shah = result.trace.people.find((person) => person.personId === "shah");
    expect(shah?.passed).toBe(false);
    expect(shah?.reasons.join(" ")).toContain("Language includes the answer to “Language?”");
  });

  it("uses the next matching route, then the fallback", () => {
    expect(resolveRouting(definition, { first: false, language: "Tamil" }, directory, attributes).destination.type).toBe("external");
    const none = resolveRouting(definition, {}, directory, attributes);
    expect(none.trace.matchedRouteId).toBe(FALLBACK_ID);
    expect(none.destination.type).toBe("message");
  });

  it("passes over a service route nobody fits, so a customer is never sent to the wrong person", () => {
    const result = resolveRouting(definition, { first: true, language: "Tamil" }, new Map([["consult", [people[1]!]]]), attributes);
    expect(result.trace.routes[0]).toMatchObject({ matched: true, skipped: "no_people" });
    expect(result.trace.matchedRouteId).toBe(FALLBACK_ID);
  });

  it("ignores answers to questions their own conditions hide", () => {
    const hidden: FormField[] = [questions[0]!, { ...questions[1]!, showWhen: [{ fieldId: "first", operator: "equals", value: "yes" }] }];
    expect(visibleAnswers(hidden, { first: false, language: "Tamil" })).toEqual({ first: false });
    const custom: RoutingDefinition = { ...definition, questions: hidden };
    expect(resolveRouting(custom, { first: false, language: "Tamil" }, directory, attributes).trace.routes[0]?.matched).toBe(false);
  });

  it("never records what the customer typed in the trace", () => {
    const trace = JSON.stringify(resolveRouting(definition, { first: true, language: "Tamil", email: "private@example.com" }, directory, attributes).trace);
    expect(trace).not.toContain("private@example.com");
  });
});

describe("choosing people", () => {
  const rule = { personIds: [], filters: [{ attributeId: "rank", operator: "at_least" as const, source: { type: "value" as const, value: 1 } }], weights: [] };

  it("never narrows on an unanswered question or a missing attribute", () => {
    const byLanguage = { personIds: [], filters: [{ attributeId: "lang", operator: "equals" as const, source: { type: "question" as const, fieldId: "language" } }], weights: [] };
    expect(selectPeople(people, byLanguage, {}, { questions, attributes }).candidateIds).toEqual([]);
    expect(selectPeople(people, rule, {}, { questions, attributes }).candidateIds).toEqual([]);
  });

  it("limits to an explicit list of people", () => {
    const picked = selectPeople(people, { personIds: ["shah"], filters: [], weights: [] }, {}, { questions, attributes });
    expect(picked.candidateIds).toEqual(["shah"]);
  });

  it("compares numbers", () => {
    const experts: DirectoryPerson[] = [{ id: "a", name: "A", attributes: { years: 3 } }, { id: "b", name: "B", attributes: { years: 9 } }];
    const picked = selectPeople(experts, { personIds: [], filters: [{ attributeId: "years", operator: "at_least", source: { type: "value", value: 5 } }], weights: [] }, {}, { questions, attributes: [{ id: "years", name: "Years" }] });
    expect(picked.candidateIds).toEqual(["b"]);
  });
});

describe("builder checks", () => {
  const route = (id: string, conditions: RoutingDefinition["routes"][number]["conditions"]) => ({ id, name: id, conditions, destination: { type: "message" as const, title: "t", body: "b" } });

  it("finds nothing wrong with an ordinary form", () => {
    expect(findUnreachable(definition)).toEqual([]);
  });

  it("warns when an earlier route catches every case", () => {
    const warnings = findUnreachable({ ...definition, routes: [route("all", []), route("late", [{ fieldId: "language", operator: "equals", value: "Tamil" }])] });
    expect(warnings.map((warning) => warning.routeId)).toEqual(["late", FALLBACK_ID]);
    expect(warnings[0]?.kind).toBe("shadowed");
  });

  it("warns when a later route is a subset of an earlier one", () => {
    const warnings = findUnreachable({
      ...definition,
      routes: [
        route("tamil", [{ fieldId: "language", operator: "one_of", value: ["Tamil", "Hindi"] }]),
        route("tamil-new", [{ fieldId: "language", operator: "equals", value: "Tamil" }, { fieldId: "first", operator: "equals", value: "yes" }]),
      ],
    });
    expect(warnings.some((warning) => warning.routeId === "tamil-new" && warning.kind === "shadowed")).toBe(true);
  });

  it("warns about contradictory conditions", () => {
    const warnings = findUnreachable({ ...definition, routes: [route("both", [{ fieldId: "language", operator: "equals", value: "Tamil" }, { fieldId: "language", operator: "equals", value: "Hindi" }])] });
    expect(warnings[0]).toMatchObject({ routeId: "both", kind: "impossible" });
  });

  it("does not warn about free-text routes that can be reached", () => {
    const text: RoutingDefinition = {
      ...definition,
      questions: [{ id: "why", type: "short_text", label: "Reason", required: false }],
      routes: [route("pain", [{ fieldId: "why", operator: "contains", value: "pain" }]), route("fever", [{ fieldId: "why", operator: "contains", value: "fever" }])],
    };
    expect(findUnreachable(text)).toEqual([]);
  });
});

describe("answers on the way to the booking", () => {
  it("shares answers by link name and fills the contact step from email and phone questions", () => {
    expect(prefillFromAnswers(questions, { first: true, language: "Tamil", email: "a@b.co" })).toEqual({ language: "Tamil", email: "a@b.co" });
  });

  it("drops answers the form's conditions hid", () => {
    const hidden: FormField[] = [questions[0]!, { ...questions[1]!, showWhen: [{ fieldId: "first", operator: "equals", value: "yes" }] }];
    expect(prefillFromAnswers(hidden, { first: false, language: "Tamil" })).toEqual({});
  });

  it("builds a booking address with ids and a token, never an answer", () => {
    expect(bookingPath("acme care", "svc1", "tok_en")).toBe("/book/acme%20care?service=svc1&routing=tok_en");
  });

  it("explains a route and a routed booking in plain words", () => {
    expect(describeConditions(definition.routes[0]!, questions)).toBe("First visit? is yes and Language? is Tamil");
    const result = resolveRouting(definition, { first: true, language: "Tamil" }, directory, attributes);
    expect(traceSummary({ ...result.trace, assignment: { personId: "iyer", name: "Dr Iyer", why: "had the fewest bookings in the last 30 days for their share" } }))
      .toBe("Routed by: First visit? = yes, Language? = Tamil. Dr Iyer had the fewest bookings in the last 30 days for their share.");
  });
});
