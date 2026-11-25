import { describe, expect, it } from "vitest";

import {
  describeWorkflow,
  fillTemplate,
  unknownTemplateVariables,
  workflowInputSchema,
  type WorkflowInput,
} from "@/lib/workflow-contracts";
import { workflowPresetsFor } from "@/lib/workflow-presets";

import { afterQuietHours, isQuietMinute, localMinuteOfDay } from "./quiet-hours";
import { skipReason } from "@/worker/handlers/workflow-message";
import { renderMessage } from "./render";
import { eventTriggerFor, planMessages, type PlanAppointment, type PlanWorkflow } from "./triggers";

const quiet = { startMinute: 21 * 60, endMinute: 8 * 60 };
const kolkata = "Asia/Kolkata";

function appointment(overrides: Partial<PlanAppointment> = {}): PlanAppointment {
  return {
    id: "appt-1", version: 1, status: "booked", formStatus: "not_assigned",
    startsAt: new Date("2026-11-23T05:30:00Z"), // 11:00 in Kolkata
    endsAt: new Date("2026-11-23T06:00:00Z"),
    completedAt: null,
    locationId: "loc-1", practitionerId: "prac-1", serviceId: "svc-1", bookingSource: "online", deliveryMode: "in_person", timeZone: kolkata,
    ...overrides,
  };
}

const step = (id: string, waitMinutes = 0, ignoreQuietHours = false) => ({ id, position: 0, waitMinutes, ignoreQuietHours });
const reminder = (id: string, offsetMinutes: number): PlanWorkflow => ({
  id, trigger: "before_start", offsetMinutes, filters: {}, steps: [step(`${id}-step`)],
});

describe("quiet hours", () => {
  it("reads the local minute in the location's own zone", () => {
    expect(localMinuteOfDay(new Date("2026-11-19T20:30:00Z"), kolkata)).toBe(2 * 60); // 02:00 IST
  });

  it("handles a window that crosses midnight", () => {
    expect(isQuietMinute(22 * 60, 21 * 60, 8 * 60)).toBe(true);
    expect(isQuietMinute(2 * 60, 21 * 60, 8 * 60)).toBe(true);
    expect(isQuietMinute(8 * 60, 21 * 60, 8 * 60)).toBe(false);
    expect(isQuietMinute(12 * 60, 21 * 60, 8 * 60)).toBe(false);
    expect(isQuietMinute(12 * 60, 9 * 60, 9 * 60)).toBe(false);
  });

  it("moves a message due at 2 am to exactly 8 am local", () => {
    const due = new Date("2026-11-19T20:30:00Z"); // 02:00 IST
    const sendAt = afterQuietHours(due, kolkata, quiet.startMinute, quiet.endMinute);
    expect(sendAt.toISOString()).toBe("2026-11-20T02:30:00.000Z"); // 08:00 IST
  });

  it("leaves a daytime message alone", () => {
    const due = new Date("2026-11-19T06:00:00Z");
    expect(afterQuietHours(due, kolkata, quiet.startMinute, quiet.endMinute)).toBe(due);
  });

  it("lands on 8 am across a clock change", () => {
    // London goes back one hour on 25 October 2026; 03:00 local that night is quiet and the end is 08:00.
    const due = new Date("2026-10-25T03:00:00Z");
    const sendAt = afterQuietHours(due, "Europe/London", quiet.startMinute, quiet.endMinute);
    expect(localMinuteOfDay(sendAt, "Europe/London")).toBe(8 * 60);
  });
});

describe("planning messages", () => {
  const now = new Date("2026-11-20T05:30:00Z"); // 3 days before the visit

  it("a booking 3 days out gets a 24-hour and a 2-hour reminder", () => {
    const planned = planMessages(appointment(), [reminder("w24", 1440), reminder("w2", 120)], quiet, now);
    expect(planned.map((message) => message.workflowId).sort()).toEqual(["w2", "w24"]);
    expect(planned.find((message) => message.workflowId === "w24")?.sendAt.toISOString()).toBe("2026-11-22T05:30:00.000Z");
    expect(planned.find((message) => message.workflowId === "w2")?.sendAt.toISOString()).toBe("2026-11-23T03:30:00.000Z");
  });

  it("holds a reminder due at 2 am until 8 am", () => {
    // Visit at 08:30 local (03:00Z); a 6.5-hour reminder is due 02:00 local, inside quiet hours.
    const early = appointment({ startsAt: new Date("2026-11-23T03:00:00Z"), endsAt: new Date("2026-11-23T03:30:00Z") });
    const [message] = planMessages(early, [reminder("w", 390)], quiet, now);
    expect(message?.sendAt.toISOString()).toBe("2026-11-23T02:30:00.000Z"); // 08:00 local
  });

  it("drops a reminder that quiet hours would push past the start", () => {
    const early = appointment({ startsAt: new Date("2026-11-23T01:30:00Z"), endsAt: new Date("2026-11-23T02:00:00Z") }); // 07:00 local
    expect(planMessages(early, [reminder("w", 120)], quiet, now)).toEqual([]);
  });

  it("sends a quiet-hours-exempt step at its own time", () => {
    const early = appointment({ startsAt: new Date("2026-11-23T03:00:00Z") });
    const workflow: PlanWorkflow = { ...reminder("w", 390), steps: [step("s", 0, true)] };
    expect(planMessages(early, [workflow], quiet, now)[0]?.sendAt.toISOString()).toBe("2026-11-22T20:30:00.000Z");
  });

  it("skips a reminder whose time has already passed", () => {
    const soon = new Date("2026-11-23T04:00:00Z"); // 1.5 hours before
    expect(planMessages(appointment(), [reminder("w24", 1440), reminder("w2", 120)], quiet, soon).map((m) => m.workflowId)).toEqual([]);
  });

  it("plans nothing for a cancelled booking", () => {
    expect(planMessages(appointment({ status: "cancelled" }), [reminder("w", 1440)], quiet, now)).toEqual([]);
  });

  it("keys a timed message by its moment, so a move away and back is the same message", () => {
    const original = planMessages(appointment(), [reminder("w", 1440)], quiet, now);
    const moved = planMessages(appointment({ startsAt: new Date("2026-11-24T05:30:00Z"), version: 2 }), [reminder("w", 1440)], quiet, now);
    const back = planMessages(appointment({ version: 3 }), [reminder("w", 1440)], quiet, now);
    expect(moved[0]?.slotKey).not.toBe(original[0]?.slotKey);
    expect(back[0]?.slotKey).toBe(original[0]?.slotKey);
  });

  it("applies filters by service, place, person and booking source", () => {
    const workflow: PlanWorkflow = { ...reminder("w", 1440), filters: { serviceIds: ["svc-2"] } };
    expect(planMessages(appointment(), [workflow], quiet, now)).toEqual([]);
    expect(planMessages(appointment({ serviceId: "svc-2" }), [workflow], quiet, now)).toHaveLength(1);
    const bySource: PlanWorkflow = { ...reminder("w", 1440), filters: { bookingSources: ["phone"] } };
    expect(planMessages(appointment(), [bySource], quiet, now)).toEqual([]);
  });

  it("chains waits: the second step goes after the first step's wait plus its own", () => {
    const workflow: PlanWorkflow = {
      id: "w", trigger: "after_end", offsetMinutes: 60, filters: {},
      steps: [{ id: "a", position: 0, waitMinutes: 0, ignoreQuietHours: true }, { id: "b", position: 1, waitMinutes: 1440, ignoreQuietHours: true }],
    };
    const done = appointment({ status: "completed" });
    const planned = planMessages(done, [workflow], quiet, new Date("2026-11-23T06:10:00Z"));
    expect(planned.map((m) => m.sendAt.toISOString())).toEqual(["2026-11-23T07:00:00.000Z", "2026-11-24T07:00:00.000Z"]);
  });

  it("sends a follow-up once per step, and not for a visit finished before workflows were switched on", () => {
    const review: PlanWorkflow = { id: "w", trigger: "after_end", offsetMinutes: 120, filters: {}, steps: [step("s", 0, true)] };
    const done = appointment({ status: "completed", completedAt: new Date("2026-11-23T06:05:00Z") });
    const after = new Date("2026-11-23T09:00:00Z");
    expect(planMessages(done, [review], quiet, after)).toHaveLength(1);
    expect(planMessages(done, [review], quiet, after, undefined, { settledSteps: new Set(["s"]) })).toEqual([]);
    expect(planMessages(done, [review], quiet, after, undefined, { followUpsSince: new Date("2026-11-24T00:00:00Z") })).toEqual([]);
    expect(planMessages(done, [review], quiet, after, undefined, { followUpsSince: new Date("2026-11-20T00:00:00Z") })).toHaveLength(1);
  });

  it("fires an event trigger once for the change that caused it", () => {
    const booked: PlanWorkflow = { id: "w", trigger: "booked", offsetMinutes: 0, filters: {}, steps: [step("s")] };
    const planned = planMessages(appointment(), [booked], quiet, now, { action: "appointment.created", version: 1 });
    expect(planned).toHaveLength(1);
    expect(planned[0]?.slotKey).toBe("e:appointment.created:1");
    expect(planMessages(appointment(), [booked], quiet, now)).toEqual([]);
  });

  it("chases a missing form only while the form is outstanding", () => {
    const chase: PlanWorkflow = { id: "w", trigger: "form_missing", offsetMinutes: 1440, filters: {}, steps: [step("s")] };
    expect(planMessages(appointment({ formStatus: "not_started" }), [chase], quiet, now)).toHaveLength(1);
    expect(planMessages(appointment({ formStatus: "submitted" }), [chase], quiet, now)).toEqual([]);
  });

  it("maps outbox actions to triggers", () => {
    expect(eventTriggerFor("appointment.created", "requested")).toBe("requested");
    expect(eventTriggerFor("appointment.created", "booked")).toBe("booked");
    expect(eventTriggerFor("appointment.reschedule", "booked")).toBe("rescheduled");
    expect(eventTriggerFor("appointment.status.cancelled", "cancelled")).toBe("cancelled");
    expect(eventTriggerFor("appointment.started", "booked")).toBeNull();
  });
});

describe("templates", () => {
  it("finds values that are not on the list", () => {
    expect(unknownTemplateVariables("Hi {customer_first_name}, {unknown} and {Other}")).toEqual(["unknown", "Other"]);
  });

  it("refuses a workflow with an unknown value and says which", () => {
    const result = workflowInputSchema.safeParse(workflowWith({ body: "See you {when}" }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("{when}");
    expect(result.error?.issues[0]?.path).toEqual(["steps", 0, "body"]);
  });

  it("refuses an unknown value in the subject too", () => {
    expect(workflowInputSchema.safeParse(workflowWith({ subject: "Hello {nope}" })).success).toBe(false);
  });

  it("requires a subject for email and a body for every channel", () => {
    expect(workflowInputSchema.safeParse(workflowWith({ subject: "" })).success).toBe(false);
    expect(workflowInputSchema.safeParse(workflowWith({ body: "" })).success).toBe(false);
  });

  it("refuses a timing on a trigger that has none", () => {
    expect(workflowInputSchema.safeParse({ ...workflowWith({}), trigger: "booked", offsetMinutes: 60 }).success).toBe(false);
  });

  it("fills the known values and leaves unknown ones as written", () => {
    expect(fillTemplate("Hi {customer_first_name} {x}", { customer_first_name: "Priya" })).toBe("Hi Priya {x}");
  });

  it("renders dates and times in the place's time zone", () => {
    const text = renderMessage({ subject: "{service} at {time}", body: "{date}, {location}. {manage_link}" }, {
      customerFirstName: "Priya", customerName: "Priya Nair", service: "Check-up", staffName: "Dr Rao",
      startsAt: new Date("2026-11-23T05:30:00Z"), timeZone: kolkata, locationName: "Main", locationAddress: "12 MG Road",
      businessName: "Riverbend", businessPhone: null, manageLink: "https://x.test/manage/t", joinLink: null, cameraTestLink: null,
    });
    expect(text.subject).toMatch(/Check-up at 11:00/);
    expect(text.body).toContain("Main, 12 MG Road");
    expect(text.body).toContain("https://x.test/manage/t");
  });

  it("reads long waits in days", () => {
    expect(describeWorkflow({ trigger: "after_end", offsetMinutes: 4320, steps: [] })).toMatch(/^3 days after the appointment ends/);
  });

  it("describes a workflow as a sentence a person can read", () => {
    const sentence = describeWorkflow({
      trigger: "before_start", offsetMinutes: 1440,
      steps: [{ channel: "email", subject: "Reminder", body: "x", templateKey: null, waitMinutes: 0, ignoreQuietHours: false, skipIfConfirmed: false }],
    }, "booking");
    expect(sentence).toBe("24 hours before the booking, send Email: Reminder");
    expect(describeWorkflow({ trigger: "before_start", offsetMinutes: 2880, steps: [] })).toMatch(/^48 hours before the appointment/);
  });

  it("every standard workflow passes the same checks an owner's would", () => {
    for (const type of ["healthcare", "wellness", "retail"] as const) {
      for (const preset of workflowPresetsFor(type)) expect(workflowInputSchema.safeParse(preset.workflow).success, preset.presetKey).toBe(true);
    }
    expect(workflowPresetsFor("healthcare").map((preset) => preset.presetKey)).toContain("form_chase");
    expect(workflowPresetsFor("wellness").map((preset) => preset.presetKey)).not.toContain("form_chase");
  });
});

function workflowWith(step: Partial<WorkflowInput["steps"][number]>) {
  return {
    name: "Test", trigger: "before_start", offsetMinutes: 60, active: true,
    steps: [{ channel: "email", subject: "Hello", body: "Hi {customer_first_name}", templateKey: null, waitMinutes: 0, ignoreQuietHours: false, skipIfConfirmed: false, ...step }],
  };
}

describe("deciding at send time", () => {
  const base = {
    trigger: "before_start" as const, appointment_status: "booked", form_status: "not_assigned",
    confirmation_status: "needs_action", skip_if_confirmed: false, starts_at: new Date("2026-11-23T05:30:00Z"),
  };
  const now = new Date("2026-11-22T05:30:00Z");

  it("sends a reminder for a booking that still stands", () => {
    expect(skipReason(base, now)).toBeNull();
  });

  it("skips a reminder for a cancelled, moved-into-the-past or finished booking", () => {
    expect(skipReason({ ...base, appointment_status: "cancelled" }, now)).toBe("booking_changed");
    expect(skipReason({ ...base, starts_at: new Date("2026-11-22T00:00:00Z") }, now)).toBe("booking_changed");
  });

  it("skips a please-confirm step once the customer has confirmed", () => {
    expect(skipReason({ ...base, skip_if_confirmed: true, confirmation_status: "confirmed" }, now)).toBe("already_confirmed");
    expect(skipReason({ ...base, skip_if_confirmed: false, confirmation_status: "confirmed" }, now)).toBeNull();
  });

  it("skips a form chase once the form is in", () => {
    expect(skipReason({ ...base, trigger: "form_missing", form_status: "submitted" }, now)).toBe("form_received");
    expect(skipReason({ ...base, trigger: "form_missing", form_status: "in_progress" }, now)).toBeNull();
  });

  it("only follows up a finished visit, and only tells about a cancellation that happened", () => {
    expect(skipReason({ ...base, trigger: "after_end", appointment_status: "booked" }, now)).toBe("booking_changed");
    expect(skipReason({ ...base, trigger: "after_end", appointment_status: "completed" }, now)).toBeNull();
    expect(skipReason({ ...base, trigger: "cancelled", appointment_status: "booked" }, now)).toBe("booking_changed");
  });
});

describe("approved messages on WhatsApp and text", () => {
  const base = { subject: "", body: "", waitMinutes: 0, ignoreQuietHours: false, skipIfConfirmed: false };
  const flow = (step: Record<string, unknown>) => ({ name: "Test", trigger: "before_start", offsetMinutes: 60, active: true, steps: [{ ...base, ...step }] });

  it("needs a WhatsApp or text step to pick an approved message", () => {
    expect(workflowInputSchema.safeParse(flow({ channel: "whatsapp" })).success).toBe(false);
    expect(workflowInputSchema.safeParse(flow({ channel: "whatsapp", templateKey: "reminder" })).success).toBe(true);
    expect(workflowInputSchema.safeParse(flow({ channel: "sms", templateKey: "booking_confirmed" })).success).toBe(true);
  });

  it("offers the review request on WhatsApp only", () => {
    expect(workflowInputSchema.safeParse(flow({ channel: "whatsapp", templateKey: "review_request" })).success).toBe(true);
    const result = workflowInputSchema.safeParse(flow({ channel: "sms", templateKey: "review_request" }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["steps", 0, "templateKey"]);
  });

  it("describes an approved-message step by its name", () => {
    expect(describeWorkflow({ trigger: "before_start", offsetMinutes: 1440, steps: [{ ...base, channel: "whatsapp", templateKey: "reminder" }] }))
      .toBe("24 hours before the appointment, send WhatsApp: Reminder");
  });
});
