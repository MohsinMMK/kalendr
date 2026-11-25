import { routingDraftSchema, type RoutingBuilderOptions, type RoutingDraft } from "@/lib/routing-forms";
import type { TermWords } from "@/lib/terminology";

/**
 * Starter routing forms for an empty list. Each one is a complete DRAFT the create route accepts as is (it is checked against the
 * same `routingDraftSchema`), so a new form opens in the builder ready to edit and publish. Words come from the business's terms.
 */
export type RoutingTemplateId = "service" | "returning" | "location";

export interface RoutingTemplate {
  id: RoutingTemplateId;
  title: string;
  description: string;
}

type Words = Pick<TermWords, "customer" | "service" | "services" | "location" | "locations">;

export function routingTemplates(t: Words): RoutingTemplate[] {
  return [
    { id: "service", title: `Which ${t.service} do you need?`, description: `Ask what the ${t.customer} came for, then send them to that ${t.service}.` },
    { id: "returning", title: `New or returning ${t.customer}`, description: `Ask if they have been before, so you can treat first-timers and regulars differently.` },
    { id: "location", title: `Pick a ${t.location}`, description: `Ask which ${t.location} suits them best.` },
  ];
}

const message = { type: "message", title: "Thanks, we'll be in touch", body: "We could not match your answers to a booking. Someone will get back to you soon." } as const;

/** The first bookable services, as plain names with their ids. */
function bookable(options: Pick<RoutingBuilderOptions, "services"> | null): Array<{ id: string; name: string }> {
  return (options?.services ?? []).filter((service) => service.active && !service.hidden).map((service) => ({ id: service.id, name: service.name.trim() }))
    .filter((service, index, all) => service.name !== "" && service.name.length <= 80 && all.findIndex((other) => other.name.toLowerCase() === service.name.toLowerCase()) === index);
}

function slugFor(base: string, suffix: string): string {
  return `${base}-${suffix}`.slice(0, 60);
}

/** The draft for one template. `suffix` keeps the web address unique (addresses are per business). */
export function buildTemplateDraft(id: RoutingTemplateId, t: Words, options: Pick<RoutingBuilderOptions, "services"> | null, suffix: string): RoutingDraft {
  const services = bookable(options).slice(0, 20);
  const first = services[0];
  const fallback = first ? { type: "service" as const, serviceId: first.id, people: { personIds: [], filters: [], weights: [] } } : message;
  const title = routingTemplates(t).find((template) => template.id === id)!;
  let input: unknown;
  if (id === "service") {
    const pickable = services.length >= 2;
    const choices = pickable ? services.map((service) => service.name) : [`First ${t.service}`, `Second ${t.service}`];
    input = {
      name: title.title, slug: slugFor("which-service", suffix), intro: `Answer one question and we will find the right ${t.service}.`,
      definition: {
        questions: [{ id: "service", type: "single_choice", label: `Which ${t.service} do you need?`, required: true, options: choices }],
        routes: pickable ? services.slice(0, 20).map((service, index) => ({
          id: `r_service_${index + 1}`, name: service.name,
          conditions: [{ fieldId: "service", operator: "equals", value: service.name }],
          destination: { type: "service", serviceId: service.id, people: { personIds: [], filters: [], weights: [] } },
        })) : [],
        fallback,
      },
    };
  } else if (id === "returning") {
    input = {
      name: title.title, slug: slugFor("new-or-returning", suffix), intro: `Tell us if you have been here before.`,
      definition: {
        questions: [{ id: "visited", type: "single_choice", label: `Have you been here before?`, required: true, options: [`No, I'm new`, `Yes, I'm a returning ${t.customer}`] }],
        routes: [],
        fallback,
      },
    };
  } else {
    input = {
      name: title.title, slug: slugFor("pick-location", suffix), intro: `Choose the ${t.location} that suits you.`,
      definition: {
        questions: [{ id: "location", type: "single_choice", label: `Which ${t.location} suits you?`, required: true, options: [`First ${t.location}`, `Second ${t.location}`] }],
        routes: [],
        fallback,
      },
    };
  }
  return routingDraftSchema.parse(input);
}
