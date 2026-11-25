import { describe, expect, it } from "vitest";

import { fieldDefinitionInputSchema, fieldDefinitionUpdateSchema, fieldKinds, type FieldKind } from "./customer-contracts";
import {
  compareFieldValues, convertFieldValue, encodeMultiValue, fieldKindLabels, formatFieldValue, normaliseFieldValue, parseMultiValue,
  type FieldShape,
} from "./customer-field-values";

const shape = (kind: FieldKind, choices: string[] = []): FieldShape => ({ kind, choices, label: "Thing" });
const ok = (kind: FieldKind, raw: string, choices: string[] = []) => normaliseFieldValue(shape(kind, choices), raw);

describe("normaliseFieldValue", () => {
  it("has a label for every kind", () => {
    expect(Object.keys(fieldKindLabels).sort()).toEqual([...fieldKinds].sort());
  });

  it("keeps text as typed, trimmed", () => {
    expect(ok("text", "  hello  ")).toEqual({ value: "hello" });
  });

  it("checks numbers", () => {
    expect(ok("number", " 12.50 ")).toEqual({ value: "12.5" });
    expect(ok("number", "-3")).toEqual({ value: "-3" });
    expect(ok("number", "abc")).toHaveProperty("error");
    expect(ok("number", "")).toHaveProperty("error");
    expect(ok("number", "1e99")).toHaveProperty("error");
  });

  it("checks dates are real days", () => {
    expect(ok("date", "2026-02-28")).toEqual({ value: "2026-02-28" });
    expect(ok("date", "2026-02-30")).toHaveProperty("error");
    expect(ok("date", "28/02/2026")).toHaveProperty("error");
  });

  it("checks a choice is one of the options", () => {
    expect(ok("choice", "Gold", ["Gold", "Silver"])).toEqual({ value: "Gold" });
    expect(ok("choice", "Bronze", ["Gold", "Silver"])).toHaveProperty("error");
  });

  it("checks a multiple choice, in the order of the list and without repeats", () => {
    const choices = ["A", "B", "C"];
    expect(ok("multichoice", encodeMultiValue(["C", "A"]), choices)).toEqual({ value: encodeMultiValue(["A", "C"]) });
    expect(ok("multichoice", encodeMultiValue(["A", "Z"]), choices)).toHaveProperty("error");
    expect(ok("multichoice", encodeMultiValue(["A", "A"]), choices)).toEqual({ value: encodeMultiValue(["A"]) });
    expect(ok("multichoice", "[]", choices)).toHaveProperty("error");
    expect(ok("multichoice", "not json", choices)).toHaveProperty("error");
  });

  it("stores yes and no as true and false so an unticked box is still an answer", () => {
    expect(ok("boolean", "Yes")).toEqual({ value: "true" });
    expect(ok("boolean", "false")).toEqual({ value: "false" });
    expect(ok("boolean", "maybe")).toHaveProperty("error");
  });

  it("checks phone numbers", () => {
    expect(ok("phone", "+91 98765 43210")).toEqual({ value: "+91 98765 43210" });
    expect(ok("phone", "12")).toHaveProperty("error");
    expect(ok("phone", "call me")).toHaveProperty("error");
  });

  it("checks and lowercases email", () => {
    expect(ok("email", " Ana@Example.COM ")).toEqual({ value: "ana@example.com" });
    expect(ok("email", "ana@")).toHaveProperty("error");
  });

  it("accepts only web links and adds https when it is missing", () => {
    expect(ok("link", "example.com/menu")).toEqual({ value: "https://example.com/menu" });
    expect(ok("link", "http://example.com")).toEqual({ value: "http://example.com" });
    expect(ok("link", "javascript:alert(1)")).toHaveProperty("error");
    expect(ok("link", "ftp://example.com")).toHaveProperty("error");
    expect(ok("link", "nodots")).toHaveProperty("error");
  });

  it("refuses a value past the limit", () => {
    expect(ok("text", "x".repeat(2_501))).toHaveProperty("error");
  });
});

describe("field definitions", () => {
  it("needs two choices for the kinds that pick from a list", () => {
    expect(fieldDefinitionInputSchema.safeParse({ label: "Tier", kind: "choice", choices: ["Gold"] }).success).toBe(false);
    expect(fieldDefinitionInputSchema.safeParse({ label: "Tags", kind: "multichoice", choices: ["A", "B"] }).success).toBe(true);
    expect(fieldDefinitionInputSchema.safeParse({ label: "Notes", kind: "text" }).success).toBe(true);
  });

  it("refuses repeated choices and unknown kinds", () => {
    expect(fieldDefinitionInputSchema.safeParse({ label: "Tier", kind: "choice", choices: ["Gold", "gold"] }).success).toBe(false);
    expect(fieldDefinitionInputSchema.safeParse({ label: "Tier", kind: "rating" }).success).toBe(false);
  });

  it("accepts a kind change and renames on update", () => {
    expect(fieldDefinitionUpdateSchema.safeParse({ kind: "email", version: 2 }).success).toBe(true);
    expect(fieldDefinitionUpdateSchema.safeParse({ choices: ["A", "B"], renames: { Old: "A" }, version: 2 }).success).toBe(true);
    expect(fieldDefinitionUpdateSchema.safeParse({ label: "x" }).success).toBe(false);
  });
});

describe("convertFieldValue", () => {
  it("keeps a text value that fits the new kind and clears one that does not", () => {
    expect(convertFieldValue(shape("text"), shape("number"), "42")).toBe("42");
    expect(convertFieldValue(shape("text"), shape("number"), "lots")).toBeNull();
    expect(convertFieldValue(shape("text"), shape("email"), "A@B.CO")).toBe("a@b.co");
  });

  it("turns a choice into a list of one, and back only from exactly one", () => {
    const list = shape("multichoice", ["A", "B"]);
    const single = shape("choice", ["A", "B"]);
    expect(convertFieldValue(single, list, "A")).toBe(encodeMultiValue(["A"]));
    expect(convertFieldValue(list, single, encodeMultiValue(["B"]))).toBe("B");
    expect(convertFieldValue(list, single, encodeMultiValue(["A", "B"]))).toBeNull();
  });

  it("drops the options that no longer exist", () => {
    const before = shape("multichoice", ["A", "B", "C"]);
    const after = shape("multichoice", ["A", "C"]);
    expect(convertFieldValue(before, after, encodeMultiValue(["B", "C"]))).toBe(encodeMultiValue(["C"]));
    expect(convertFieldValue(before, after, encodeMultiValue(["B"]))).toBeNull();
    expect(convertFieldValue(shape("choice", ["A", "B"]), shape("choice", ["A"]), "B")).toBeNull();
  });

  it("reads a yes or no and a list as words when the field becomes text", () => {
    expect(convertFieldValue(shape("boolean"), shape("text"), "true")).toBe("Yes");
    expect(convertFieldValue(shape("multichoice", ["A", "B"]), shape("text"), encodeMultiValue(["A", "B"]))).toBe("A, B");
  });
});

describe("showing and sorting values", () => {
  it("formats values for reading", () => {
    expect(formatFieldValue(shape("boolean"), "true")).toBe("Yes");
    expect(formatFieldValue(shape("boolean"), "false")).toBe("No");
    expect(formatFieldValue(shape("multichoice", ["A", "B"]), encodeMultiValue(["A", "B"]))).toBe("A, B");
    expect(formatFieldValue(shape("date"), "2026-03-14")).toBe("14 Mar 2026");
    expect(parseMultiValue("garbage")).toEqual([]);
  });

  it("sorts numbers by size, dates by day, text alphabetically, and empty last", () => {
    expect(compareFieldValues(shape("number"), "9", "10")).toBeLessThan(0);
    expect(compareFieldValues(shape("date"), "2026-01-02", "2025-12-31")).toBeGreaterThan(0);
    expect(compareFieldValues(shape("text"), "apple", "Banana")).toBeLessThan(0);
    expect(compareFieldValues(shape("text"), undefined, "a")).toBeGreaterThan(0);
    expect(compareFieldValues(shape("text"), "a", undefined)).toBeLessThan(0);
  });
});
