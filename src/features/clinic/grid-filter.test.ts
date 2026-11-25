import { describe, expect, it } from "vitest";

import { createFilterQuery, createFilterRule } from "@/components/reui/filters/filters-query";

import { matchesFilterQuery } from "./grid-filter";

const read = (row: { kind: string; name: string }, field: string) => (field === "kind" ? row.kind : row.name);
const rows = [{ kind: "note", name: "Ananya" }, { kind: "report", name: "Priya" }, { kind: "prescription", name: "Ankit" }];
const run = (query: ReturnType<typeof createFilterQuery>) => rows.filter((row) => matchesFilterQuery(row, query, read)).map((row) => row.name);

describe("matchesFilterQuery", () => {
  it("keeps every row while a rule has no value yet", () => {
    expect(run(createFilterQuery([createFilterRule({ id: "a", path: ["kind"], operator: "is_any_of", value: [] })]))).toHaveLength(3);
  });

  it("matches any of the picked values, and their opposite", () => {
    const picked = createFilterRule({ id: "a", path: ["kind"], operator: "is_any_of", value: ["note", "report"] });
    expect(run(createFilterQuery([picked]))).toEqual(["Ananya", "Priya"]);
    expect(run(createFilterQuery([{ ...picked, operator: "is_none_of" }]))).toEqual(["Ankit"]);
  });

  it("matches text without caring about case, and ANDs rules together", () => {
    const starts = createFilterRule({ id: "a", path: ["name"], operator: "starts_with", value: "AN" });
    expect(run(createFilterQuery([starts]))).toEqual(["Ananya", "Ankit"]);
    const both = createFilterQuery([starts, createFilterRule({ id: "b", path: ["kind"], operator: "is", value: "note" })]);
    expect(run(both)).toEqual(["Ananya"]);
  });
});
