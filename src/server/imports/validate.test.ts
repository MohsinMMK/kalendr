import { describe, expect, it } from "vitest";

import { importErrorCodes, type DateFormat } from "./contracts";
import { parseDate, parseDateAndTime, parseTime } from "./dates";
import {
  normaliseAppointment, normaliseCustomer, normalisePhoneNumber, normaliseService, parseDurationMinutes, phoneKeyOf, type RowSettings,
} from "./validate";

const settings: RowSettings = { dateFormat: "dd/mm/yyyy", region: "IN", today: "2026-11-19" };

describe("phone numbers", () => {
  it.each([
    ["98450 12345", "+919845012345"],
    ["09845012345", "+919845012345"],
    ["+91-98450-12345", "+919845012345"],
    ["(+91) 98450 12345", "+919845012345"],
    ["91 98450 12345", "+919845012345"],
    ["0091 98450 12345", "+919845012345"],
    ["98450-12345 ext 22", "+919845012345"],
    ["9845012345.0", "+919845012345"],
    ["  +91 9845012345  ", "+919845012345"],
  ])("reads %j", (messy, e164) => {
    expect(normalisePhoneNumber(messy, "IN")).toBe(e164);
  });

  it.each([["12345"], ["abc"], ["98450"], ["+91 98450 123456789"], [""]])("refuses %j", (bad) => {
    expect(normalisePhoneNumber(bad, "IN")).toBeNull();
  });

  it("uses the business's country for numbers with no code, and an explicit +code wins", () => {
    expect(normalisePhoneNumber("415 555 2671", "US")).toBe("+14155552671");
    expect(normalisePhoneNumber("+91 98450 12345", "US")).toBe("+919845012345");
  });

  it("matches the way the database reads stored numbers", () => {
    // kalendr_normalize_phone('09845012345') and ('98450 12345') are both 919845012345.
    for (const stored of ["09845012345", "98450 12345", "+91 98450 12345"]) {
      const digits = stored.replace(/[^0-9]/g, "");
      const sqlKey = digits.length === 10 ? `91${digits}` : digits.length === 11 && digits.startsWith("0") ? `91${digits.slice(1)}` : digits;
      expect(phoneKeyOf(normalisePhoneNumber(stored, "IN")!)).toBe(sqlKey);
    }
  });
});

describe("dates", () => {
  it.each<[string, DateFormat, string | null]>([
    ["14/03/1990", "dd/mm/yyyy", "1990-03-14"],
    ["4-3-1990", "dd/mm/yyyy", "1990-03-04"],
    ["03/14/1990", "mm/dd/yyyy", "1990-03-14"],
    ["1990-03-14", "yyyy-mm-dd", "1990-03-14"],
    ["14-Mar-1990", "d-mmm-yyyy", "1990-03-14"],
    ["14 march 1990", "d-mmm-yyyy", "1990-03-14"],
    ["1990-03-14", "dd/mm/yyyy", "1990-03-14"],
    ["31/02/2020", "dd/mm/yyyy", null],
    ["29/02/2023", "dd/mm/yyyy", null],
    ["29/02/2024", "dd/mm/yyyy", "2024-02-29"],
    ["13/13/2020", "mm/dd/yyyy", null],
    ["14/03/90", "dd/mm/yyyy", null],
    ["32-Jan-2020", "d-mmm-yyyy", null],
    ["14-Foo-2020", "d-mmm-yyyy", null],
    ["14/03/1990", "yyyy-mm-dd", null],
    ["", "dd/mm/yyyy", null],
  ])("%j as %s is %j", (text, format, expected) => {
    expect(parseDate(text, format)).toBe(expected);
  });

  it("reads times", () => {
    expect(parseTime("14:30")).toBe("14:30");
    expect(parseTime("2:30 pm")).toBe("14:30");
    expect(parseTime("2pm")).toBe("14:00");
    expect(parseTime("2:00PM")).toBe("14:00");
    expect(parseTime("12:00 AM")).toBe("00:00");
    expect(parseTime("25:00")).toBeNull();
    expect(parseTime("14")).toBeNull();
  });

  it("reads a date and time in one cell", () => {
    expect(parseDateAndTime("15/03/2027 14:30", "dd/mm/yyyy")).toEqual({ date: "2027-03-15", time: "14:30" });
    expect(parseDateAndTime("2027-03-15T14:30", "dd/mm/yyyy")).toEqual({ date: "2027-03-15", time: "14:30" });
    expect(parseDateAndTime("15-Mar-2027 2:30 pm", "d-mmm-yyyy")).toEqual({ date: "2027-03-15", time: "14:30" });
    expect(parseDateAndTime("15/03/2027", "dd/mm/yyyy")).toEqual({ date: "2027-03-15", time: null });
    expect(parseDateAndTime("31/02/2027 10:00", "dd/mm/yyyy")).toBeNull();
  });
});

describe("customers", () => {
  const row = { firstName: "Asha", lastName: "Rao", phone: "98450 12345", email: "Asha@Example.COM", dateOfBirth: "14/03/1990" };

  it("normalises a good row", () => {
    const result = normaliseCustomer(row, settings);
    expect(result).toMatchObject({ ok: true, value: { phone: "+919845012345", email: "asha@example.com", dateOfBirth: "1990-03-14", preferredChannel: "email", messagingConsent: false, phoneKey: "919845012345", emailKey: "asha@example.com" } });
  });

  it("defaults the channel to phone when there is no email, and never invents consent", () => {
    const result = normaliseCustomer({ firstName: "Meera", phone: "09876501234" }, settings);
    expect(result).toMatchObject({ ok: true, value: { preferredChannel: "phone", email: "", lastName: "", messagingConsent: false } });
  });

  it.each([
    [{ ...row, firstName: "" }, "required_missing", "firstName"],
    [{ ...row, phone: "" }, "required_missing", "phone"],
    [{ ...row, phone: "12345" }, "invalid_phone", "phone"],
    [{ ...row, email: "not-an-email" }, "invalid_email", "email"],
    [{ ...row, dateOfBirth: "31/02/1990" }, "invalid_date", "dateOfBirth"],
    [{ ...row, dateOfBirth: "14/03/2090" }, "invalid_date", "dateOfBirth"],
    [{ ...row, dateOfBirth: "14/03/1850" }, "invalid_date", "dateOfBirth"],
    [{ ...row, firstName: "x".repeat(81) }, "too_long", "firstName"],
    [{ ...row, preferredChannel: "pigeon" }, "invalid_value", "preferredChannel"],
    [{ ...row, email: "", preferredChannel: "email" }, "invalid_value", "preferredChannel"],
    [{ ...row, messagingConsent: "maybe" }, "invalid_value", "messagingConsent"],
  ])("refuses %# with a fixed code", (bad, code, field) => {
    expect(normaliseCustomer(bad, settings)).toEqual({ ok: false, issue: { code, field } });
  });

  it("reads consent words and channel words", () => {
    expect(normaliseCustomer({ ...row, messagingConsent: "Yes", preferredChannel: "Text" }, settings)).toMatchObject({ ok: true, value: { messagingConsent: true, preferredChannel: "sms" } });
    expect(normaliseCustomer({ ...row, messagingConsent: "N" }, settings)).toMatchObject({ ok: true, value: { messagingConsent: false } });
  });

  it("never puts a cell value in an error", () => {
    const secrets = { firstName: "Zed-Secret", lastName: "Zed-Last", phone: "999-secret-phone", email: "zed@secret.example", dateOfBirth: "99/99/9999" };
    for (const field of Object.keys(secrets) as Array<keyof typeof secrets>) {
      const result = normaliseCustomer({ ...row, [field]: secrets[field] }, settings);
      if (result.ok) continue;
      expect(importErrorCodes).toContain(result.issue.code);
      expect(JSON.stringify(result)).not.toMatch(/Zed|secret|99\/99/i);
    }
  });
});

describe("services", () => {
  it("normalises a service and a price", () => {
    expect(normaliseService({ name: "Consultation", durationMinutes: "30 min", price: "Rs 1,200", category: "General" }))
      .toMatchObject({ ok: true, value: { durationMinutes: 30, priceLabel: "₹1,200", priceMinor: 120000, description: "Consultation", bookingMode: "instant", nameKey: "consultation" } });
    expect(normaliseService({ name: "Big", durationMinutes: "1h 30m", price: "From 500" }))
      .toMatchObject({ ok: true, value: { durationMinutes: 90, priceLabel: "From 500", priceMinor: null } });
  });

  it.each([
    [{ name: "", durationMinutes: "30" }, "required_missing", "name"],
    [{ name: "A", durationMinutes: "30" }, "required_missing", "name"],
    [{ name: "Cut", durationMinutes: "" }, "required_missing", "durationMinutes"],
    [{ name: "Cut", durationMinutes: "soon" }, "invalid_value", "durationMinutes"],
    [{ name: "Cut", durationMinutes: "3" }, "invalid_value", "durationMinutes"],
    [{ name: "Cut", durationMinutes: "900" }, "invalid_value", "durationMinutes"],
    [{ name: "Cut", durationMinutes: "30", mode: "sometimes" }, "invalid_value", "mode"],
  ])("refuses %# with a fixed code", (bad, code, field) => {
    expect(normaliseService(bad)).toEqual({ ok: false, issue: { code, field } });
  });

  it("reads lengths", () => {
    expect([parseDurationMinutes("45"), parseDurationMinutes("1h"), parseDurationMinutes("1.5 hours"), parseDurationMinutes("2 hrs 15 mins"), parseDurationMinutes("45m"), parseDurationMinutes("abc")])
      .toEqual([45, 60, 90, 135, 45, null]);
  });
});

describe("appointments", () => {
  const base = { customerPhone: "98450 12345", service: " Consultation ", staff: "Dr. A. Rao", startsAt: "15/03/2027", startTime: "2:30 pm" };

  it("reads date and time columns, and matches names loosely", () => {
    expect(normaliseAppointment(base, settings)).toMatchObject({ ok: true, value: { customerPhoneKey: "919845012345", serviceKey: "consultation", staffKey: "a rao", date: "2027-03-15", time: "14:30", durationMinutes: null } });
    expect(normaliseAppointment({ ...base, startsAt: "15/03/2027 09:00", startTime: "" }, settings)).toMatchObject({ ok: true, value: { time: "09:00" } });
  });

  it.each([
    [{ ...base, customerPhone: "" }, "required_missing", "customerPhone"],
    [{ ...base, startsAt: "31/02/2027" }, "invalid_date", "startsAt"],
    [{ ...base, startTime: "" }, "required_missing", "startTime"],
    [{ ...base, startTime: "tea time" }, "invalid_date", "startTime"],
    [{ ...base, durationMinutes: "2" }, "invalid_value", "durationMinutes"],
    [{ ...base, service: "" }, "required_missing", "service"],
  ])("refuses %# with a fixed code", (bad, code, field) => {
    expect(normaliseAppointment(bad, settings)).toEqual({ ok: false, issue: { code, field } });
  });
});
