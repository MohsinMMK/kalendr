import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { compileSegment, countSegmentSql } from "./segment-sql";

const dialect = new PgDialect();
const context = { tenantId: "tenant-1", now: new Date("2026-11-20T00:00:00Z") };

describe("segment SQL", () => {
  it("binds every value as a parameter, never as text in the query", () => {
    const hostile = "x') or 1=1 --";
    const query = dialect.sqlToQuery(countSegmentSql({ all: [
      { field: "tag", op: "has", tagIds: [hostile] },
      { field: "service", op: "used", serviceIds: [hostile] },
      { field: "lastVisit", op: "before", date: "2026-01-01" },
    ] }, context));
    expect(query.sql).not.toContain(hostile);
    expect(query.sql).not.toContain("1=1");
    expect(query.params).toContain(hostile);
    expect(query.params).toContain("tenant-1");
  });

  it("only adds the aggregates a filter needs", () => {
    const plain = dialect.sqlToQuery(compileSegment({ all: [{ field: "tag", op: "has", tagIds: ["a"] }] }, context).from);
    expect(plain.sql).not.toContain("visit_stats");
    const withVisits = dialect.sqlToQuery(countSegmentSql({ all: [{ field: "visits", op: "gt", value: 3 }] }, context));
    expect(withVisits.sql).toContain("visit_stats");
    expect(withVisits.sql).not.toContain("spend_stats");
    expect(withVisits.sql).toContain(">");
  });

  it("refuses a filter that does not validate", () => {
    // @ts-expect-error a field the schema does not know
    expect(() => compileSegment({ all: [{ field: "drop table", op: "gt", value: 1 }] }, context)).toThrow();
  });

  it("always leaves out merged, erased and sample customers", () => {
    const { sql: text } = dialect.sqlToQuery(compileSegment({ all: [] }, context).from);
    expect(text).toContain("merged_into_id is null");
    expect(text).toContain("erased_at is null");
    expect(text).toContain("not p.is_test");
  });
});
