import { describe, expect, it } from "vitest";

import { permissionKeys, resolvePermissions } from "./permissions";
import {
  alertKinds,
  alertPermissions,
  alertTime,
  alertTitle,
  appointmentLink,
  isAppPath,
  isPublicHost,
  mayReceiveAlert,
  pushJobSchema,
  pushSubscriptionInputSchema,
} from "./staff-alerts";

const keys = { p256dh: "B".repeat(87), auth: "a".repeat(22) };

describe("staff alerts", () => {
  it("only names permissions that exist, so a typo cannot silence an alert", () => {
    for (const kind of alertKinds) for (const permission of alertPermissions[kind]) expect(permissionKeys).toContain(permission);
  });

  it("sends each kind only to roles that could open the thing it is about", () => {
    const owner = resolvePermissions("owner", {});
    const receptionist = resolvePermissions("receptionist", {});
    const practitioner = resolvePermissions("practitioner", {});
    const readOnly = resolvePermissions("read_only", {});
    const billing = resolvePermissions("billing", {});
    expect(alertKinds.every((kind) => mayReceiveAlert(owner, kind))).toBe(true);
    expect(mayReceiveAlert(receptionist, "booking_request")).toBe(true);
    expect(mayReceiveAlert(practitioner, "booking_request")).toBe(false);
    expect(mayReceiveAlert(practitioner, "payment")).toBe(false);
    expect(mayReceiveAlert(billing, "payment")).toBe(true);
    expect(alertKinds.some((kind) => mayReceiveAlert(readOnly, kind))).toBe(false);
  });

  it("writes short titles in the business's own time, with the date only when it is not today", () => {
    const now = new Date("2026-11-19T06:00:00Z");
    expect(alertTime(new Date("2026-11-19T11:00:00Z"), "Asia/Kolkata", now)).toBe("4:30 pm");
    expect(alertTime(new Date("2026-11-24T11:00:00Z"), "Asia/Kolkata", now)).toBe("Tue 24 Nov, 4:30 pm");
    expect(alertTitle("new_booking", "4:30 pm")).toBe("New booking at 4:30 pm");
    for (const kind of alertKinds) expect(alertTitle(kind).length).toBeLessThan(60);
  });

  it("only links inside the app", () => {
    expect(appointmentLink("a b")).toBe("/schedule?open=a%20b");
    expect(isAppPath("/schedule?open=1")).toBe(true);
    for (const bad of ["https://evil.example", "//evil.example", "javascript:alert(1)", "schedule", "/a\\b"]) expect(isAppPath(bad)).toBe(false);
    expect(pushJobSchema.safeParse({ membershipId: "m", title: "x", kind: "payment", link: "https://evil.example" }).success).toBe(false);
  });

  it("refuses push addresses that are not public https, because the worker posts to them", () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
    ]) expect(pushSubscriptionInputSchema.safeParse({ endpoint, keys }).success).toBe(true);
    for (const endpoint of [
      "http://fcm.googleapis.com/x",
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://10.0.0.5/x",
      "https://[::1]/x",
      "https://intranet/x",
      "https://db.internal/x",
      "ftp://push.example.com/x",
    ]) expect(pushSubscriptionInputSchema.safeParse({ endpoint, keys }).success, endpoint).toBe(false);
    expect(isPublicHost("https://push.example.com/x")).toBe(true);
    expect(pushSubscriptionInputSchema.safeParse({ endpoint: "https://push.example.com/x", keys: { p256dh: "short", auth: "a".repeat(22) } }).success).toBe(false);
  });

  it("a push goes to one person only", () => {
    expect(pushJobSchema.safeParse({ title: "x", kind: "k" }).success).toBe(false);
    expect(pushJobSchema.safeParse({ title: "x", kind: "k", membershipId: "m", patientId: "p" }).success).toBe(false);
    expect(pushJobSchema.safeParse({ title: "x", kind: "k", patientId: "p", link: "/portal" }).success).toBe(true);
  });
});
