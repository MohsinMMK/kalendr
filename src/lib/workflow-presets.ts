import { isClinicalBusinessType, type BusinessTypeId } from "./business-types";
import type { WorkflowInput } from "./workflow-contracts";

/**
 * The standard set every new business starts with, keyed by `presetKey` so turning it on twice adds nothing.
 * Owners edit these from Settings. The wording matches the backfill in drizzle/0033_message_workflows.sql.
 */
export interface WorkflowPreset {
  presetKey: string;
  workflow: WorkflowInput;
}

const email = (subject: string, body: string) => ({
  channel: "email" as const, subject, body, templateKey: null, waitMinutes: 0, ignoreQuietHours: false, skipIfConfirmed: false,
});
const noFilters = { serviceIds: [], locationIds: [], practitionerIds: [], bookingSources: [], deliveryModes: [] };

export function workflowPresetsFor(businessType: BusinessTypeId): WorkflowPreset[] {
  const standard: WorkflowPreset[] = [
    {
      presetKey: "reminder_24h",
      workflow: {
        name: "Reminder 24 hours before", trigger: "before_start", offsetMinutes: 1440, filters: noFilters, active: true,
        steps: [email(
          "Reminder: {service} on {date} at {time}",
          "Hi {customer_first_name},\n\nThis is a reminder from {business_name}: {service} with {staff_name} on {date} at {time}, {location}.\n\nIf you can no longer make it, please change or cancel so someone else can have the time: {manage_link}",
        )],
      },
    },
    {
      presetKey: "reminder_2h",
      workflow: {
        name: "Reminder 2 hours before", trigger: "before_start", offsetMinutes: 120, filters: noFilters, active: true,
        steps: [email("Today at {time}: {service}", "Hi {customer_first_name},\n\nSee you soon: {service} with {staff_name} at {time}, {location}.\n\nChange or cancel: {manage_link}")],
      },
    },
    {
      presetKey: "review_request",
      workflow: {
        name: "Ask for a review", trigger: "after_end", offsetMinutes: 120, filters: noFilters, active: true,
        steps: [email(
          "How was your visit with {business_name}?",
          "Hi {customer_first_name},\n\nThanks for visiting {business_name}. A quick rating helps them, and helps others choose.\n\nRate your visit in one tap: {rating_link}",
        )],
      },
    },
  ];
  standard.push({
    presetKey: "video_link",
    workflow: {
      name: "Send the video link", trigger: "before_start", offsetMinutes: 60, active: true,
      filters: { ...noFilters, deliveryModes: ["video"] },
      steps: [email(
        "Your video visit at {time}: join link inside",
        "Hi {customer_first_name},\n\nYour video visit with {staff_name} is at {time} on {date}.\n\nJoin here, from 15 minutes before: {join_link}\n\nTry your camera and microphone first: {camera_test_link}",
      )],
    },
  });
  if (isClinicalBusinessType(businessType)) {
    standard.push({
      presetKey: "form_chase",
      workflow: {
        name: "Chase a missing form", trigger: "form_missing", offsetMinutes: 1440, filters: noFilters, active: false,
        steps: [email(
          "Please fill in your form before {date}",
          "Hi {customer_first_name},\n\nWe still need your form before your visit on {date} at {time}. It takes a couple of minutes: {manage_link}",
        )],
      },
    });
  }
  return standard;
}
