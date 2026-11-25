import { describe, expect, it } from "vitest";

import { applyMapping, guessMapping, headerKey, missingRequiredFields } from "./map";

describe("guessMapping, customers", () => {
  it("reads messy header names", () => {
    const headers = ["First Name ", "SURNAME", "Phone No.", "E-mail", "D.O.B", "Notes"];
    const mapping = guessMapping(headers, "customers");
    expect(mapping).toMatchObject({ firstName: 0, lastName: 1, phone: 2, email: 3, dateOfBirth: 4, fullName: null });
  });

  it.each([["Mobile"], ["Phone No"], ["Contact"], ["Cell"], ["Tel"], ["MOBILE NUMBER"], ["WhatsApp No"], ["phone_number"]])("maps %s to phone", (header) => {
    expect(guessMapping(["Name", header], "customers").phone).toBe(1);
  });

  it.each([["E-mail"], ["Mail"], ["Email Address"], ["EMAIL ID"]])("maps %s to email", (header) => {
    expect(guessMapping(["Name", header], "customers").email).toBe(1);
  });

  it.each([["DOB"], ["Birth date"], ["Date of Birth"], ["Birthday"]])("maps %s to date of birth", (header) => {
    expect(guessMapping(["Name", header], "customers").dateOfBirth).toBe(1);
  });

  it("maps a lone Name column to full name, and splits it when there is no first-name column", () => {
    const mapping = guessMapping(["Name", "Mobile"], "customers");
    expect(mapping).toMatchObject({ fullName: 0, firstName: null, phone: 1 });
    expect(applyMapping(["Mary Ann Smith", "9876543210"], mapping, "customers")).toMatchObject({ firstName: "Mary Ann", lastName: "Smith", phone: "9876543210" });
    expect(applyMapping(["Cher", "1"], mapping, "customers")).toMatchObject({ firstName: "Cher", lastName: "" });
  });

  it("prefers a real first-name column over Name", () => {
    const mapping = guessMapping(["Name", "First name", "Last name", "Phone"], "customers");
    expect(mapping.firstName).toBe(1);
    expect(mapping.fullName).toBeNull();
  });

  it("does not take 'Contact Name' as the phone", () => {
    const mapping = guessMapping(["Contact Name", "Mobile"], "customers");
    expect(mapping.phone).toBe(1);
  });

  it("uses each column once", () => {
    const mapping = guessMapping(["Phone", "Phone"], "customers");
    expect([mapping.phone, mapping.email].filter((value) => value !== null).length).toBe(1);
  });
});

describe("guessMapping, services and appointments", () => {
  it("maps service columns", () => {
    expect(guessMapping(["Service Name", "Duration (mins)", "Cost", "Category", "About"], "services"))
      .toMatchObject({ name: 0, durationMinutes: 1, price: 2, category: 3, description: 4 });
  });

  it("maps appointment columns", () => {
    const mapping = guessMapping(["Mobile", "Treatment", "Doctor", "Appointment Date", "Time"], "appointments");
    expect(mapping).toMatchObject({ customerPhone: 0, service: 1, staff: 2, startsAt: 3, startTime: 4 });
  });
});

describe("required fields", () => {
  it("needs a name and a phone for customers, either name form", () => {
    expect(missingRequiredFields("customers", { phone: 1 })).toEqual(["firstName"]);
    expect(missingRequiredFields("customers", { fullName: 0, phone: 1 })).toEqual([]);
    expect(missingRequiredFields("customers", { firstName: 0 })).toEqual(["phone"]);
  });
  it("needs phone or email for appointments", () => {
    expect(missingRequiredFields("appointments", { service: 0, staff: 1, startsAt: 2 })).toEqual(["customerPhone"]);
    expect(missingRequiredFields("appointments", { customerEmail: 3, service: 0, staff: 1, startsAt: 2 })).toEqual([]);
  });
  it("needs name and length for services", () => {
    expect(missingRequiredFields("services", {})).toEqual(["name", "durationMinutes"]);
  });
});

describe("headerKey", () => {
  it("ignores case, spacing, accents and punctuation", () => {
    expect(headerKey(" Téléphone No. ")).toBe("telephoneno");
  });
});
