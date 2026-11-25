import { describe, expect, it } from "vitest";

import type { StaffRole } from "./permissions";
import { defaultChannels, planStaffAlert, type PlanMember } from "./staff-alert-plan";

const NOW = new Date("2026-11-20T09:00:00Z");
const member = (id: string, role: StaffRole, extra: Partial<PlanMember> = {}): PlanMember => ({
  id, userId: `user-${id}`, role, overrides: {}, quietStartMinute: null, quietEndMinute: null, choice: null, hasPushDevice: true, ...extra,
});
const plan = (members: PlanMember[], extra: Partial<Parameters<typeof planStaffAlert>[0]> = {}) =>
  planStaffAlert({ kind: "new_booking", members, aboutAppointment: true, appointmentPractitionerUserId: "user-doc", now: NOW, timeZone: "Asia/Kolkata", ...extra });
const byId = (planned: ReturnType<typeof plan>, id: string) => planned.find((entry) => entry.membershipId === id);

describe("who is told, and how", () => {
  it("tells a practitioner about their own booking by push and in the app, and nobody else's", () => {
    const planned = plan([member("doc", "practitioner", { userId: "user-doc" }), member("other-doc", "practitioner")]);
    expect(byId(planned, "doc")).toMatchObject({ inApp: true, push: { availableAt: NOW }, email: null });
    expect(byId(planned, "other-doc")).toBeUndefined();
  });

  it("gives receptionists everything in the app and nothing by push, and owners the bell too", () => {
    const planned = plan([member("desk", "receptionist"), member("boss", "owner")]);
    expect(byId(planned, "desk")).toMatchObject({ inApp: true, push: null, email: null });
    expect(byId(planned, "boss")).toMatchObject({ inApp: true, push: null, email: null });
    expect(defaultChannels("owner")).toEqual({ inApp: true, push: false, email: false });
  });

  it("never tells someone who could not open the appointment, or the person who did it", () => {
    const planned = plan([member("view", "read_only"), member("bill", "billing"), member("desk", "receptionist", { userId: "me" })], { exceptUserId: "me" });
    expect(planned).toEqual([]);
  });

  it("follows a person's own choices, including email", () => {
    const planned = plan([member("desk", "receptionist", { choice: { inApp: false, push: true, email: true } })]);
    expect(byId(planned, "desk")).toMatchObject({ inApp: false, push: { availableAt: NOW }, email: { availableAt: NOW } });
    expect(plan([member("desk", "receptionist", { choice: { inApp: false, push: false, email: false } })])).toEqual([]);
  });

  it("sends no push to someone with no device", () => {
    const planned = plan([member("doc", "practitioner", { userId: "user-doc", hasPushDevice: false })]);
    expect(byId(planned, "doc")).toMatchObject({ inApp: true, push: null });
  });

  it("holds push and email until quiet hours end, while the bell still shows at once", () => {
    // 14:30 in Kolkata; quiet from 14:00 to 15:00 local.
    const planned = plan([member("doc", "practitioner", { userId: "user-doc", quietStartMinute: 14 * 60, quietEndMinute: 15 * 60, choice: { inApp: true, push: true, email: true } })]);
    const held = byId(planned, "doc")!;
    expect(held.inApp).toBe(true);
    expect(held.push?.availableAt.toISOString()).toBe("2026-11-20T09:30:00.000Z");
    expect(held.email?.availableAt.toISOString()).toBe("2026-11-20T09:30:00.000Z");
  });

  it("does not filter by person for an alert that is not about one appointment", () => {
    const planned = planStaffAlert({ kind: "message", members: [member("doc", "practitioner")], aboutAppointment: false, now: NOW, timeZone: "UTC" });
    expect(planned).toEqual([]);
    const desk = planStaffAlert({ kind: "message", members: [member("desk", "receptionist")], aboutAppointment: false, now: NOW, timeZone: "UTC" });
    expect(desk).toHaveLength(1);
  });
});
