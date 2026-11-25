import { describe, expect, it } from "vitest";

import { createFilterQuery, createFilterRule } from "@/components/reui/filters/filters-query";

import { matchesFilterQuery } from "./grid-filter";

type Row = Record<string, unknown>;
const read = (row: Row, field: string) => row[field];
const matches = (row: Row, operator: string, value: unknown, field = "f") =>
  matchesFilterQuery(row, createFilterQuery([createFilterRule({ id: "r", path: [field], operator, value })]), read);

describe("matchesFilterQuery on the business's own fields", () => {
  it("compares numbers as numbers, so 12.50 finds a stored 12.5", () => {
    expect(matches({ f: "12.5" }, "eq", "12.50")).toBe(true);
    expect(matches({ f: "12.5" }, "neq", "12.50")).toBe(false);
    expect(matches({ f: "9" }, "gt", "10")).toBe(false);
    expect(matches({ f: "11" }, "gt", "10")).toBe(true);
    expect(matches({ f: "10" }, "gte", "10")).toBe(true);
    expect(matches({ f: "10" }, "lt", "10")).toBe(false);
    expect(matches({ f: "10" }, "lte", "10")).toBe(true);
  });

  it("matches no number rule for a customer with no answer", () => {
    expect(matches({ f: "" }, "gt", "1")).toBe(false);
    expect(matches({ f: undefined }, "lte", "1")).toBe(false);
  });

  it("handles ranges", () => {
    expect(matches({ f: "5" }, "between", ["1", "10"])).toBe(true);
    expect(matches({ f: "50" }, "between", ["1", "10"])).toBe(false);
    expect(matches({ f: "50" }, "not_between", ["1", "10"])).toBe(true);
    expect(matches({ f: "" }, "not_between", ["1", "10"])).toBe(false);
  });

  it("reads a multiple choice as a list: any of means at least one", () => {
    expect(matches({ f: ["Gold", "Yoga"] }, "is_any_of", ["Yoga", "Spin"])).toBe(true);
    expect(matches({ f: ["Gold"] }, "is_any_of", ["Yoga", "Spin"])).toBe(false);
    expect(matches({ f: ["Gold"] }, "is_none_of", ["Yoga"])).toBe(true);
    expect(matches({ f: [] }, "empty", undefined)).toBe(true);
    expect(matches({ f: ["Gold"] }, "not_empty", undefined)).toBe(true);
  });

  it("keeps text and exact matching, and ignores a rule that has no value yet", () => {
    expect(matches({ f: "Hello World" }, "contains", "world")).toBe(true);
    expect(matches({ f: "2026-03-14" }, "is", "2026-03-14")).toBe(true);
    expect(matches({ f: "x" }, "contains", undefined)).toBe(true);
    expect(matches({ f: "x" }, "", undefined)).toBe(true);
  });
});
