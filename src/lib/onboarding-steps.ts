import { z } from "zod";

import type { TermWords } from "./terminology";

/**
 * The first-run checklist (feature 11): eight steps, each one click from where it is done, each done, to do or skipped.
 * Pure rules, no database. The server gathers a few facts about the business (`OnboardingFacts`), `resolveSteps` turns
 * them with the saved marks into the list the card shows, and `summarise` answers the questions the emails and the
 * go-live check ask ("how many are done?", "has the owner finished?").
 */

export const checklistKeys = ["services", "hours", "team", "test_booking", "reminders", "brand", "share_link", "payments"] as const;
export type ChecklistKey = (typeof checklistKeys)[number];
export const checklistKeySchema = z.enum(checklistKeys);

/** Bookkeeping rows that are not checklist steps: whether the tour was seen, and whether sample data is in. */
export const bookkeepingKeys = ["tour", "sample_data"] as const;
export type BookkeepingKey = (typeof bookkeepingKeys)[number];

export type StepStatus = "done" | "todo" | "skipped";

/** Where a step is done. Settings sections are opened by name; panels are opened in place on the dashboard. */
export type StepTarget =
  | { kind: "settings"; section: "patient" | "hours" | "brand" | "payments" | "workflows" }
  | { kind: "panel"; panel: "test_booking" | "share_link" }
  | { kind: "page"; href: string };

interface StepDefinition {
  key: ChecklistKey;
  optional: boolean;
  /** `auto` steps are found done from the business's own data; `manual` steps are marked by the owner (or by the action itself). */
  detection: "auto" | "manual";
  target: StepTarget;
  actionLabel: string;
}

export const stepDefinitions: Record<ChecklistKey, StepDefinition> = {
  services: { key: "services", optional: false, detection: "manual", target: { kind: "settings", section: "patient" }, actionLabel: "Review" },
  hours: { key: "hours", optional: false, detection: "manual", target: { kind: "settings", section: "hours" }, actionLabel: "Set hours" },
  team: { key: "team", optional: false, detection: "auto", target: { kind: "page", href: "/doctors?tab=access" }, actionLabel: "Add people" },
  test_booking: { key: "test_booking", optional: false, detection: "manual", target: { kind: "panel", panel: "test_booking" }, actionLabel: "Make a test booking" },
  reminders: { key: "reminders", optional: false, detection: "auto", target: { kind: "settings", section: "workflows" }, actionLabel: "Review" },
  brand: { key: "brand", optional: false, detection: "auto", target: { kind: "settings", section: "brand" }, actionLabel: "Add logo and cover" },
  share_link: { key: "share_link", optional: false, detection: "manual", target: { kind: "panel", panel: "share_link" }, actionLabel: "Share the link" },
  payments: { key: "payments", optional: true, detection: "auto", target: { kind: "settings", section: "payments" }, actionLabel: "Connect" },
};

/** The words a step shows, in the business's own terms. */
export function stepWords(key: ChecklistKey, t: Pick<TermWords, "services" | "customers" | "appointments">): { title: string; detail: string } {
  switch (key) {
    case "services": return { title: `Confirm your ${t.services}`, detail: `Check the names, lengths and prices ${t.customers} will see.` };
    case "hours": return { title: "Set your hours", detail: `${t.customers} can only book inside the times you open.` };
    case "team": return { title: "Add your team", detail: `Invite the people who take ${t.appointments}, or skip if it is only you.` };
    case "test_booking": return { title: "Make a test booking", detail: `Book yourself on your own page and see it land on your schedule.` };
    case "reminders": return { title: "Turn on reminders", detail: "Reminders cut no-shows. They are on by default; check the wording." };
    case "brand": return { title: "Add your logo and cover photo", detail: "A cover photo across the top of your page shows people where they are booking." };
    case "share_link": return { title: "Share your booking link", detail: `Put it where ${t.customers} will find it.` };
    case "payments": return { title: "Connect payments (optional)", detail: "Take deposits or full payment when someone books." };
  }
}

export interface StoredMark {
  doneAt: Date | null;
  skippedAt: Date | null;
}

/** What the server learned about the business. Counts and flags only. */
export interface OnboardingFacts {
  marks: Partial<Record<ChecklistKey | BookkeepingKey, StoredMark>>;
  activeTeamMembers: number;
  activeReminderWorkflows: number;
  hasLogoOrColour: boolean;
  paymentsConnected: boolean;
}

export interface StepView {
  key: ChecklistKey;
  status: StepStatus;
  optional: boolean;
  target: StepTarget;
  actionLabel: string;
  /** When it was first seen done, for the funnel. */
  doneAt: Date | null;
  /** True when the facts alone show it done and no mark is stored yet, so the server should store one. */
  newlyDetected: boolean;
}

function detected(key: ChecklistKey, facts: OnboardingFacts): boolean {
  switch (key) {
    case "team": return facts.activeTeamMembers >= 2;
    case "reminders": return facts.activeReminderWorkflows >= 1;
    case "brand": return facts.hasLogoOrColour;
    case "payments": return facts.paymentsConnected;
    default: return false;
  }
}

export function resolveSteps(facts: OnboardingFacts): StepView[] {
  return checklistKeys.map((key) => {
    const definition = stepDefinitions[key];
    const mark = facts.marks[key];
    const found = definition.detection === "auto" && detected(key, facts);
    const stored = Boolean(mark?.doneAt);
    // A step the owner skipped stays skipped until they do it; finishing it for real wins over a skip.
    const status: StepStatus = stored || found ? "done" : mark?.skippedAt ? "skipped" : "todo";
    return {
      key, status, optional: definition.optional, target: definition.target, actionLabel: definition.actionLabel,
      doneAt: mark?.doneAt ?? null, newlyDetected: found && !stored,
    };
  });
}

export interface ChecklistSummary {
  done: number;
  skipped: number;
  total: number;
  /** The first step still to do, in order. Null when none is. */
  next: ChecklistKey | null;
  /** Every step is done or skipped. */
  finished: boolean;
  /** At least half the steps are done. The day-1 email is not sent past this. */
  halfDone: boolean;
}

export function summarise(steps: readonly StepView[]): ChecklistSummary {
  const done = steps.filter((step) => step.status === "done").length;
  const skipped = steps.filter((step) => step.status === "skipped").length;
  const total = steps.length;
  return {
    done, skipped, total,
    next: steps.find((step) => step.status === "todo")?.key ?? null,
    finished: done + skipped === total,
    halfDone: done * 2 >= total,
  };
}

// ---- Go-live check ----

export const goLiveCheckIds = ["services_bookable", "hours_set", "reminders_working", "contact_details", "test_data_present"] as const;
export type GoLiveCheckId = (typeof goLiveCheckIds)[number];

export interface GoLiveFacts {
  /** Active, listed services that at least one active person can take at their working times. */
  bookableServices: number;
  /** People with at least one weekly range. */
  peopleWithHours: number;
  /** Whether any reminder channel can reach a customer: email is set up on this Kalendr, or WhatsApp or text is connected. */
  reminderChannelWorks: boolean;
  /** The business phone and address are filled in (both appear on the booking page). */
  hasPhoneAndAddress: boolean;
  /** Test or sample bookings and customers are still in. */
  testRows: number;
}

export interface GoLiveCheck {
  id: GoLiveCheckId;
  /** True means nothing to fix. */
  ok: boolean;
  message: string;
  fix: StepTarget;
}

/** The short list of things that would embarrass the owner if a customer found them. Each says what is wrong and where to fix it. */
export function goLiveChecks(facts: GoLiveFacts, t: Pick<TermWords, "customers" | "services">): GoLiveCheck[] {
  return [
    {
      id: "services_bookable", ok: facts.bookableServices > 0,
      message: facts.bookableServices > 0 ? `${facts.bookableServices} ${t.services} can be booked online.` : `No ${t.services} can be booked online yet. Check that each one is shown, has a person, and that person has hours.`,
      fix: { kind: "settings", section: "patient" },
    },
    {
      id: "hours_set", ok: facts.peopleWithHours > 0,
      message: facts.peopleWithHours > 0 ? "Opening hours are set." : `No opening hours are set, so ${t.customers} see no times.`,
      fix: { kind: "settings", section: "hours" },
    },
    {
      id: "reminders_working", ok: facts.reminderChannelWorks,
      message: facts.reminderChannelWorks ? "Reminders can be sent." : `No reminder channel is working, so ${t.customers} will not get reminders.`,
      fix: { kind: "settings", section: "workflows" },
    },
    {
      id: "contact_details", ok: facts.hasPhoneAndAddress,
      message: facts.hasPhoneAndAddress ? "Your phone number and address are on the page." : `Your phone number or address is missing, so ${t.customers} cannot reach or find you.`,
      fix: { kind: "settings", section: "patient" },
    },
    {
      id: "test_data_present", ok: facts.testRows === 0,
      message: facts.testRows === 0 ? "No test or sample data is left." : "Test or sample bookings and customers are still in your account. Remove them before you share the link.",
      fix: { kind: "panel", panel: "test_booking" },
    },
  ];
}

export function goLiveClear(checks: readonly GoLiveCheck[]): boolean {
  return checks.every((check) => check.ok);
}

// ---- Onboarding email series ----

export const day1Hours = 24;
export const day3Hours = 72;

export type OnboardingEmailKind = "onboarding_welcome" | "onboarding_day1" | "onboarding_day3";

/**
 * Which emails of the series are due now for a business that signed up `ageHours` ago. Each stops when its goal is met:
 * "finish setting up" goes only to an owner who is under half done and has not finished; "share your link" only to an owner
 * with no real booking yet. (The day-11 "trial ends in 3 days" email is the billing sweep's own, feature 14.)
 */
export function dueOnboardingEmails(input: { ageHours: number; summary: ChecklistSummary; realBookings: number }): OnboardingEmailKind[] {
  const due: OnboardingEmailKind[] = [];
  if (input.ageHours >= day1Hours && !input.summary.finished && !input.summary.halfDone) due.push("onboarding_day1");
  if (input.ageHours >= day3Hours && input.realBookings === 0) due.push("onboarding_day3");
  return due;
}
