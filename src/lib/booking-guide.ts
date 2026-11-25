import { z } from "zod";

import type { BusinessTypeId } from "./business-types";
import type { Practitioner, Service } from "./domain";

/**
 * The booking guide: a few questions a business asks before showing who to book with. Each answer points
 * at the services it fits, so the answers narrow the list of services and people. The guide is plain data:
 * the same checks run in the builder, on the server and on the customer page.
 */

export interface GuideOption {
  id: string;
  label: string;
  description?: string;
  /** The services this answer fits. Empty means the answer narrows nothing, such as "Not sure". */
  serviceIds: string[];
}

export interface GuideQuestion {
  id: string;
  label: string;
  help?: string;
  /** True: the customer may pick several answers. */
  multiple: boolean;
  options: GuideOption[];
}

export interface BookingGuide {
  isActive: boolean;
  title: string;
  intro: string;
  questions: GuideQuestion[];
}

/** The chosen option ids for each question id. */
export type GuideAnswers = Record<string, string[]>;

export const guideLimits = {
  title: 80,
  intro: 300,
  questions: 8,
  label: 160,
  help: 240,
  options: 12,
  option: 80,
  optionDescription: 160,
  services: 200,
} as const;

const idSchema = z.string().trim().regex(/^[a-z0-9_-]{1,40}$/i, "Use letters, numbers, dashes or underscores.");

const optionSchema = z
  .object({
    id: idSchema,
    label: z.string().trim().min(1, "Write the answer.").max(guideLimits.option),
    description: z.string().trim().max(guideLimits.optionDescription).optional(),
    serviceIds: z.array(z.string().min(1).max(80)).max(guideLimits.services).default([]),
  })
  .transform((option): GuideOption => ({
    id: option.id,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    serviceIds: [...new Set(option.serviceIds)],
  }));

const questionSchema = z
  .object({
    id: idSchema,
    label: z.string().trim().min(1, "Write the question.").max(guideLimits.label),
    help: z.string().trim().max(guideLimits.help).optional(),
    multiple: z.boolean().default(false),
    options: z.array(optionSchema).max(guideLimits.options, `A question can have up to ${guideLimits.options} answers.`),
  })
  .superRefine((question, context) => {
    if (question.options.length < 2) {
      context.addIssue({ code: "custom", path: ["options"], message: `“${question.label}” needs at least two answers.` });
    }
    const ids = new Set<string>();
    const labels = new Set<string>();
    question.options.forEach((option, index) => {
      if (ids.has(option.id)) context.addIssue({ code: "custom", path: ["options", index, "id"], message: "Two answers share the same id." });
      ids.add(option.id);
      const label = option.label.toLowerCase();
      if (labels.has(label)) context.addIssue({ code: "custom", path: ["options", index, "label"], message: `“${question.label}” has the same answer twice.` });
      labels.add(label);
    });
  })
  .transform((question): GuideQuestion => ({
    id: question.id,
    label: question.label,
    ...(question.help ? { help: question.help } : {}),
    multiple: question.multiple,
    options: question.options,
  }));

/** Checks a guide an owner built. Used by the staff API and the builder. */
export const bookingGuideSchema = z
  .object({
    isActive: z.boolean().default(true),
    title: z.string().trim().min(1, "Give the guide a title.").max(guideLimits.title),
    intro: z.string().trim().max(guideLimits.intro).default(""),
    questions: z.array(questionSchema).min(1, "Add at least one question.").max(guideLimits.questions, `A guide can have up to ${guideLimits.questions} questions.`),
  })
  .superRefine((guide, context) => {
    const ids = new Set<string>();
    guide.questions.forEach((question, index) => {
      if (ids.has(question.id)) context.addIssue({ code: "custom", path: ["questions", index, "id"], message: "Two questions share the same id." });
      ids.add(question.id);
    });
  });

/** A stored guide, or null when it is missing or no longer passes the checks. */
export function parseStoredGuide(value: unknown): BookingGuide | null {
  if (!value || typeof value !== "object") return null;
  const parsed = bookingGuideSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The guide as customers may see it: only services that can still be booked. An answer whose services are
 * all gone is left out, and a question left with fewer than two answers is left out too. Null when the
 * guide is off or nothing is left to ask.
 */
export function publicGuide(guide: BookingGuide | null | undefined, bookableServiceIds: Iterable<string>): BookingGuide | null {
  if (!guide || !guide.isActive) return null;
  const bookable = new Set(bookableServiceIds);
  const questions = guide.questions
    .map((question) => ({
      ...question,
      options: question.options
        // An answer that pointed at services stays only while one of them can still be booked.
        .filter((option) => option.serviceIds.length === 0 || option.serviceIds.some((id) => bookable.has(id)))
        .map((option) => ({ ...option, serviceIds: option.serviceIds.filter((id) => bookable.has(id)) })),
    }))
    .filter((question) => question.options.length >= 2);
  return questions.length > 0 ? { ...guide, questions } : null;
}

/** Keeps only answers the guide still offers; one answer for a pick-one question. */
export function cleanGuideAnswers(guide: BookingGuide, answers: GuideAnswers): GuideAnswers {
  const clean: GuideAnswers = {};
  for (const question of guide.questions) {
    const offered = new Set(question.options.map((option) => option.id));
    const chosen = [...new Set(answers[question.id] ?? [])].filter((id) => offered.has(id));
    if (chosen.length > 0) clean[question.id] = question.multiple ? chosen : chosen.slice(0, 1);
  }
  return clean;
}

export interface GuideMatch<S, P> {
  services: S[];
  people: P[];
  /** False when no answer narrowed anything, so the lists are simply everything. */
  narrowed: boolean;
}

/**
 * The services and people that fit the answers. Within a question, any chosen answer may fit (and an
 * answer with no services fits everything); across questions, a service must fit every one.
 */
export function matchGuide<S extends Pick<Service, "id" | "practitionerIds">, P extends Pick<Practitioner, "id">>(
  guide: BookingGuide,
  answers: GuideAnswers,
  services: readonly S[],
  people: readonly P[],
): GuideMatch<S, P> {
  const chosen = cleanGuideAnswers(guide, answers);
  const narrowing: Set<string>[] = [];
  for (const question of guide.questions) {
    const picked = question.options.filter((option) => chosen[question.id]?.includes(option.id));
    if (picked.length === 0 || picked.some((option) => option.serviceIds.length === 0)) continue;
    narrowing.push(new Set(picked.flatMap((option) => option.serviceIds)));
  }
  const matchedServices = services.filter((service) => narrowing.every((fits) => fits.has(service.id)));
  const personIds = new Set(matchedServices.flatMap((service) => service.practitionerIds));
  return { services: matchedServices, people: people.filter((person) => personIds.has(person.id)), narrowed: narrowing.length > 0 };
}

/** Each answered question with the words the customer chose, for the summary checklist. */
export function guideSummary(guide: BookingGuide, answers: GuideAnswers): { id: string; question: string; chosen: string[] }[] {
  const clean = cleanGuideAnswers(guide, answers);
  return guide.questions
    .filter((question) => clean[question.id])
    .map((question) => ({
      id: question.id,
      question: question.label,
      chosen: question.options.filter((option) => clean[question.id].includes(option.id)).map((option) => option.label),
    }));
}

/** Answers as one short piece of a link, such as "q1.a1.a2~q2.a3". Ids never hold a dot or a tilde. */
export function encodeGuideAnswers(answers: GuideAnswers): string {
  return Object.entries(answers)
    .filter(([, chosen]) => chosen.length > 0)
    .map(([questionId, chosen]) => [questionId, ...chosen].join("."))
    .join("~");
}

/** Reads answers back from a link. Anything the guide does not offer is dropped by cleanGuideAnswers. */
export function decodeGuideAnswers(text: string | null | undefined): GuideAnswers {
  const answers: GuideAnswers = {};
  for (const part of (text ?? "").slice(0, 2_000).split("~")) {
    const [questionId, ...chosen] = part.split(".").filter(Boolean);
    if (questionId && chosen.length > 0) answers[questionId] = chosen;
  }
  return answers;
}

/** A short, stable id for a new question or answer. */
export function newGuideId(prefix: "q" | "a", existing: readonly { id: string }[]): string {
  const taken = new Set(existing.map((entry) => entry.id));
  for (let index = existing.length + 1; ; index += 1) {
    const id = `${prefix}${index}`;
    if (!taken.has(id)) return id;
  }
}

interface StarterWords {
  title: string;
  intro: string;
  need: string;
  needHelp: string;
  time: string;
}

/** The wording each business type starts with. Owners can change every word. */
const starterWords: Record<BusinessTypeId, StarterWords> = {
  healthcare: { title: "Find the right care", intro: "Answer a few questions and we'll show who can help.", need: "What kind of care do you need?", needHelp: "Pick all that apply.", time: "How long a visit do you want?" },
  dental: { title: "Find the right dentist", intro: "Answer a few questions and we'll show who can help.", need: "What do you need help with?", needHelp: "Pick all that apply.", time: "How long a visit do you want?" },
  wellness: { title: "Find your session", intro: "Answer a few questions and we'll show what fits.", need: "What are you in the mood for?", needHelp: "Pick as many as you like.", time: "How much time do you have?" },
  real_estate: { title: "Find the right agent", intro: "Answer a few questions and we'll show who can help.", need: "What are you looking for?", needHelp: "Pick all that apply.", time: "How much time do you have?" },
  professional_services: { title: "Find the right expert", intro: "Answer a few questions and we'll show who can help.", need: "What do you need help with?", needHelp: "Pick all that apply.", time: "How long a meeting do you want?" },
  retail: { title: "Find what you need", intro: "Answer a few questions and we'll show what fits.", need: "What can we help you with?", needHelp: "Pick all that apply.", time: "How much time do you have?" },
  education: { title: "Find the right class", intro: "Answer a few questions and we'll show what fits.", need: "What do you want to learn?", needHelp: "Pick as many as you like.", time: "How long a session do you want?" },
  other: { title: "Help me choose", intro: "Answer a few questions and we'll show what fits.", need: "What do you need help with?", needHelp: "Pick all that apply.", time: "How much time do you have?" },
};

const SHORT_VISIT_MINUTES = 30;

/**
 * A ready-made guide built from the business's own services: one question by category (or by service
 * when there are no categories) and, when visits differ in length, one about time.
 */
export function starterGuide(
  businessType: BusinessTypeId,
  services: readonly Pick<Service, "id" | "name" | "category" | "durationMinutes">[],
): BookingGuide {
  const words = starterWords[businessType] ?? starterWords.other;
  const questions: GuideQuestion[] = [];

  const byCategory = new Map<string, string[]>();
  for (const service of services) {
    const category = service.category?.trim();
    if (!category) continue;
    const ids = byCategory.get(category);
    if (ids) ids.push(service.id);
    else byCategory.set(category, [service.id]);
  }
  const needOptions: GuideOption[] =
    byCategory.size >= 2
      ? [...byCategory].map(([label, serviceIds], index) => ({ id: `a${index + 1}`, label: label.slice(0, guideLimits.option), serviceIds }))
      : services.map((service, index) => ({ id: `a${index + 1}`, label: service.name.slice(0, guideLimits.option), serviceIds: [service.id] }));
  const shown = needOptions.slice(0, guideLimits.options - 1);
  questions.push({
    id: "q1",
    label: words.need,
    help: words.needHelp,
    multiple: true,
    options: [
      ...shown,
      { id: `a${shown.length + 1}`, label: "I'm not sure", description: "Show me everything.", serviceIds: [] },
    ],
  });

  const short = services.filter((service) => service.durationMinutes <= SHORT_VISIT_MINUTES).map((service) => service.id);
  const long = services.filter((service) => service.durationMinutes > SHORT_VISIT_MINUTES).map((service) => service.id);
  if (short.length > 0 && long.length > 0) {
    questions.push({
      id: "q2",
      label: words.time,
      multiple: false,
      options: [
        { id: "a1", label: `Up to ${SHORT_VISIT_MINUTES} minutes`, serviceIds: short },
        { id: "a2", label: `Longer than ${SHORT_VISIT_MINUTES} minutes`, serviceIds: long },
        { id: "a3", label: "Either is fine", serviceIds: [] },
      ],
    });
  }

  return { isActive: true, title: words.title, intro: words.intro, questions };
}
