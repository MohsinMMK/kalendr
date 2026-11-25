/**
 * Fills a workflow message with one booking's details. Dates and times are written in the place's own time zone.
 * No "server-only": the worker renders messages.
 */
import { fillTemplate, templateVariables, type TemplateVariable } from "../../lib/workflow-contracts";

export interface RenderContext {
  customerFirstName: string;
  customerName: string;
  service: string;
  staffName: string;
  startsAt: Date;
  timeZone: string;
  locationName: string;
  locationAddress: string;
  businessName: string;
  businessPhone: string | null;
  manageLink: string | null;
  joinLink: string | null;
  cameraTestLink: string | null;
  /** The one-tap rating link (feature 51). Only made for a message that uses it. */
  ratingLink?: string | null;
}

export function formatDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone }).format(at);
}

export function formatTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone }).format(at);
}

export function templateValues(context: RenderContext): Record<TemplateVariable, string> {
  return {
    customer_first_name: context.customerFirstName,
    customer_name: context.customerName,
    service: context.service,
    staff_name: context.staffName,
    date: formatDate(context.startsAt, context.timeZone),
    time: formatTime(context.startsAt, context.timeZone),
    location: [context.locationName, context.locationAddress].filter(Boolean).join(", "),
    business_name: context.businessName,
    business_phone: context.businessPhone ?? "",
    manage_link: context.manageLink ?? "",
    join_link: context.joinLink ?? "",
    camera_test_link: context.cameraTestLink ?? "",
    rating_link: context.ratingLink ?? "",
  };
}

export function renderMessage(template: { subject: string; body: string }, context: RenderContext): { subject: string; body: string } {
  const values = templateValues(context);
  return { subject: fillTemplate(template.subject, values).replace(/\s+/g, " ").trim(), body: fillTemplate(template.body, values).trim() };
}

/** What the editor's preview and the "send me a test" message use. */
export const sampleValues: Record<TemplateVariable, string> = Object.fromEntries(
  templateVariables.map((variable) => [variable.key, variable.example]),
) as Record<TemplateVariable, string>;
