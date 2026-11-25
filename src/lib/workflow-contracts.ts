import { z } from "zod";

import { smsTemplateKeys } from "./channel-templates";

/**
 * Message workflows (feature 5), shared by the server, the worker and the editor screen.
 * Nothing here touches the database or the network, so every screen can import it.
 */

export const workflowTriggers = [
  "booked",
  "requested",
  "rescheduled",
  "cancelled",
  "before_start",
  "after_end",
  "no_show",
  "form_missing",
  "checked_in",
] as const;
export type WorkflowTrigger = (typeof workflowTriggers)[number];

export interface TriggerInfo {
  key: WorkflowTrigger;
  label: string;
  /** Whether the timing field means anything for this trigger. */
  timed: boolean;
  /** How the timing reads: "before the start", "after the end", "after it happens". */
  direction: "before" | "after";
  /** Words for the sentence: "24 hours before the appointment starts". */
  hint: string;
}

export const triggerCatalogue: Record<WorkflowTrigger, TriggerInfo> = {
  booked: { key: "booked", label: "When it is booked", timed: false, direction: "after", hint: "As soon as a booking is confirmed" },
  requested: { key: "requested", label: "When a request comes in", timed: false, direction: "after", hint: "When a customer asks and you still have to approve" },
  rescheduled: { key: "rescheduled", label: "When it is moved", timed: false, direction: "after", hint: "When the time is changed by the customer or by you" },
  cancelled: { key: "cancelled", label: "When it is cancelled", timed: false, direction: "after", hint: "When a booking is cancelled" },
  before_start: { key: "before_start", label: "Before it starts", timed: true, direction: "before", hint: "A reminder ahead of the start time" },
  after_end: { key: "after_end", label: "After it finishes", timed: true, direction: "after", hint: "A follow-up once the visit is marked finished" },
  no_show: { key: "no_show", label: "When they don't turn up", timed: false, direction: "after", hint: "When the visit is marked as a no-show" },
  form_missing: { key: "form_missing", label: "Form still missing", timed: true, direction: "before", hint: "Chase a form that has not been filled in" },
  checked_in: { key: "checked_in", label: "When they check in", timed: false, direction: "after", hint: "When the customer is marked as arrived" },
};

/**
 * The channel keys a step may use. A plain string, so a new channel is one line here and one line where its
 * sender is registered. `ready` is filled in by the server for the signed-in business.
 */
export const workflowChannelKeys = ["email", "whatsapp", "sms"] as const;
export type WorkflowChannelKey = (typeof workflowChannelKeys)[number];
export const channelLabels: Record<WorkflowChannelKey, string> = { email: "Email", whatsapp: "WhatsApp", sms: "Text message" };

export interface WorkflowChannelStatus {
  key: WorkflowChannelKey;
  label: string;
  ready: boolean;
  /** Why it can't be used yet, in a sentence. Empty when ready. */
  reason: string;
}

/** The named values a template may use. Anything else is refused when the template is saved. */
export const templateVariables = [
  { key: "customer_first_name", label: "Customer's first name", example: "Priya" },
  { key: "customer_name", label: "Customer's full name", example: "Priya Nair" },
  { key: "service", label: "Service", example: "Check-up" },
  { key: "staff_name", label: "Staff member", example: "Dr Rao" },
  { key: "date", label: "Date", example: "Mon, 16 Nov 2026" },
  { key: "time", label: "Time", example: "10:30 am" },
  { key: "location", label: "Place", example: "Main branch, 12 MG Road" },
  { key: "business_name", label: "Business name", example: "Riverbend Care" },
  { key: "business_phone", label: "Business phone", example: "+91 98765 43210" },
  { key: "manage_link", label: "Link to change or cancel", example: "https://kalendr.example/manage/…" },
  { key: "join_link", label: "Video visit link", example: "https://kalendr.example/visit/…" },
  { key: "rating_link", label: "Link to rate the visit", example: "https://kalendr.example/r/…" },
  { key: "camera_test_link", label: "Camera test link", example: "https://kalendr.example/visit/…?test=1" },
] as const;
export type TemplateVariable = (typeof templateVariables)[number]["key"];
const variableKeys: ReadonlySet<string> = new Set(templateVariables.map((variable) => variable.key));

const VARIABLE_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The `{names}` in a template that are not in the list above, in order and without repeats. */
export function unknownTemplateVariables(template: string): string[] {
  const unknown: string[] = [];
  for (const match of template.matchAll(VARIABLE_PATTERN)) {
    const name = match[1] ?? "";
    if (!variableKeys.has(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}

/** Fills the known `{names}`. A name with no value becomes an empty string; unknown names are left as written. */
export function fillTemplate(template: string, values: Partial<Record<string, string>>): string {
  return template.replace(VARIABLE_PATTERN, (whole, name: string) => (variableKeys.has(name) ? values[name] ?? "" : whole));
}

export const MAX_STEPS = 5;
/** Longest wait or offset: 60 days. */
export const MAX_MINUTES = 60 * 24 * 60;

export const workflowFiltersSchema = z.object({
  serviceIds: z.array(z.string().min(1)).max(100).default([]),
  locationIds: z.array(z.string().min(1)).max(100).default([]),
  practitionerIds: z.array(z.string().min(1)).max(100).default([]),
  bookingSources: z.array(z.string().min(1).max(20)).max(10).default([]),
  /** in_person, video, phone. Empty means every way. A video-only reminder carries the join link. */
  deliveryModes: z.array(z.enum(["in_person", "video", "phone"])).max(3).default([]),
});
export type WorkflowFilters = z.infer<typeof workflowFiltersSchema>;

/**
 * WhatsApp and text messages only send wording the provider has approved, so a step on those channels picks one
 * of the approved messages instead of writing its own. Email steps write their own words.
 */
export const workflowTemplateKeys = ["reminder", "booking_confirmed", "rescheduled", "cancelled", "review_request"] as const;
export type WorkflowTemplateKey = (typeof workflowTemplateKeys)[number];
export const workflowTemplateLabels: Record<WorkflowTemplateKey, { label: string; hint: string }> = {
  reminder: { label: "Reminder", hint: "Time, place and a link to change or cancel. On WhatsApp it has Confirm and Reschedule buttons." },
  booking_confirmed: { label: "Booking confirmed", hint: "Says the booking is confirmed, with the time and a link." },
  rescheduled: { label: "Booking moved", hint: "Says the time changed, with the new time and a link." },
  cancelled: { label: "Booking cancelled", hint: "Says the booking was cancelled." },
  review_request: { label: "Ask for a review", hint: "Asks how the visit went, with a link. WhatsApp only." },
};

/** The approved messages a channel can send: text messages have no review request. */
export function templateKeysFor(channel: WorkflowChannelKey): readonly WorkflowTemplateKey[] {
  return channel === "sms" ? workflowTemplateKeys.filter((key) => smsTemplateKeys.has(key)) : channel === "whatsapp" ? workflowTemplateKeys : [];
}

const templateField = (max: number) => z.string().trim().max(max);

export const workflowStepInputSchema = z.object({
  channel: z.enum(workflowChannelKeys),
  subject: templateField(200).default(""),
  body: templateField(2000).default(""),
  /** Which approved message to send. Set for WhatsApp and text steps, empty for email. */
  templateKey: z.enum(workflowTemplateKeys).nullable().default(null),
  /** Minutes to wait after the step before it (or after the trigger for the first step). */
  waitMinutes: z.number().int().min(0).max(MAX_MINUTES).default(0),
  ignoreQuietHours: z.boolean().default(false),
  skipIfConfirmed: z.boolean().default(false),
});
export type WorkflowStepInput = z.infer<typeof workflowStepInputSchema>;

export const workflowInputSchema = z.object({
  name: z.string().trim().min(1, "Give the workflow a name.").max(160),
  trigger: z.enum(workflowTriggers),
  offsetMinutes: z.number().int().min(0).max(MAX_MINUTES).default(0),
  filters: workflowFiltersSchema.default({ serviceIds: [], locationIds: [], practitionerIds: [], bookingSources: [], deliveryModes: [] }),
  active: z.boolean().default(true),
  steps: z.array(workflowStepInputSchema).min(1, "Add at least one message.").max(MAX_STEPS),
}).superRefine((value, context) => {
  value.steps.forEach((step, index) => {
    for (const [field, text] of [["subject", step.subject], ["body", step.body]] as const) {
      const unknown = unknownTemplateVariables(text);
      if (unknown.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, field],
          message: `${unknown.map((name) => `{${name}}`).join(", ")} isn't something we can fill in. Pick from the list of values.`,
        });
      }
    }
    if (step.channel === "email") {
      if (step.subject.length === 0) context.addIssue({ code: "custom", path: ["steps", index, "subject"], message: "Give the email a subject." });
      if (step.body.length === 0) context.addIssue({ code: "custom", path: ["steps", index, "body"], message: "Write the message this step sends." });
    } else if (!step.templateKey) {
      context.addIssue({ code: "custom", path: ["steps", index, "templateKey"], message: "Pick which approved message to send." });
    } else if (!templateKeysFor(step.channel).includes(step.templateKey)) {
      context.addIssue({ code: "custom", path: ["steps", index, "templateKey"], message: "That message isn't available on this channel. Pick another." });
    }
  });
  if (!triggerCatalogue[value.trigger].timed && value.offsetMinutes !== 0) {
    context.addIssue({ code: "custom", path: ["offsetMinutes"], message: "This trigger has no timing. Use a wait on the message instead." });
  }
});
export type WorkflowInput = z.infer<typeof workflowInputSchema>;

export const workflowUpdateSchema = workflowInputSchema.safeExtend({
  expectedVersion: z.number().int().positive(),
});

export const workflowSettingsSchema = z.object({
  /** Minutes after local midnight when quiet hours start (default 9 pm = 1260) and end (default 8 am = 480). */
  quietStartMinute: z.number().int().min(0).max(1439),
  quietEndMinute: z.number().int().min(0).max(1439),
});
export type WorkflowSettings = z.infer<typeof workflowSettingsSchema>;

export const DEFAULT_QUIET_START_MINUTE = 21 * 60;
export const DEFAULT_QUIET_END_MINUTE = 8 * 60;

export interface WorkflowStepView extends WorkflowStepInput {
  id: string;
}

export interface WorkflowView {
  id: string;
  name: string;
  trigger: WorkflowTrigger;
  offsetMinutes: number;
  filters: WorkflowFilters;
  active: boolean;
  version: number;
  presetKey: string | null;
  steps: WorkflowStepView[];
  /** The readable one-line description of what this workflow does. */
  sentence: string;
}

export interface WorkflowOptions {
  services: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  practitioners: { id: string; name: string }[];
  bookingSources: { key: string; label: string }[];
  channels: WorkflowChannelStatus[];
}

export interface WorkflowListView {
  workflows: WorkflowView[];
  settings: WorkflowSettings;
  options: WorkflowOptions;
  /** True in preview mode and when the database is off: the screen explains instead of saving. */
  unavailable: boolean;
}

export function describeDuration(minutes: number): string {
  if (minutes === 0) return "right away";
  // Up to 48 hours reads naturally in hours ("24 hours before"); longer waits read in days.
  if (minutes % 1440 === 0 && minutes > 2880) return `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"} ${minutes % 60} minutes`;
}

/**
 * "24 hours before the appointment, send WhatsApp: Reminder with Confirm button."
 * The words for the appointment come from the business, so a salon reads "booking".
 */
export function describeWorkflow(
  workflow: Pick<WorkflowInput, "trigger" | "offsetMinutes" | "steps">,
  appointmentWord = "appointment",
): string {
  const { trigger, offsetMinutes } = workflow;
  const when = (() => {
    switch (trigger) {
      case "before_start": return `${describeDuration(offsetMinutes)} before the ${appointmentWord}`;
      case "form_missing": return `${describeDuration(offsetMinutes)} before the ${appointmentWord}, if the form is still missing`;
      case "after_end": return `${describeDuration(offsetMinutes)} after the ${appointmentWord} ends`;
      case "booked": return `When a ${appointmentWord} is booked`;
      case "requested": return `When a ${appointmentWord} is requested`;
      case "rescheduled": return `When a ${appointmentWord} is moved`;
      case "cancelled": return `When a ${appointmentWord} is cancelled`;
      case "no_show": return `When a customer doesn't turn up`;
      case "checked_in": return `When a customer checks in`;
    }
  })();
  const sends = workflow.steps.map((step, index) => {
    const prefix = step.waitMinutes > 0
      ? `${index > 0 ? "then " : ""}wait ${describeDuration(step.waitMinutes)} and `
      : index > 0 ? "then " : "";
    const text = step.templateKey ? workflowTemplateLabels[step.templateKey].label : step.subject || step.body;
    const short = text.length > 40 ? `${text.slice(0, 40).trimEnd()}…` : text;
    return `${prefix}send ${channelLabels[step.channel]}: ${short}`;
  });
  return `${when.charAt(0).toUpperCase()}${when.slice(1)}, ${sends.join(", ")}`;
}
