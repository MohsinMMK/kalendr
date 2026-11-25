import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { birthdayKey, classifySql, localDay, poolSql, summarise, type AudienceCampaign } from "./audience";

const dialect = new PgDialect();
const context = { tenantId: "t1", now: new Date("2026-02-28T10:00:00Z"), timeZone: "Asia/Kolkata" };

describe("audience", () => {
  it("reads 'today' in the business's own time zone", () => {
    expect(localDay(new Date("2026-02-27T20:00:00Z"), "Asia/Kolkata")).toBe("2026-02-28");
    expect(localDay(new Date("2026-02-27T20:00:00Z"), "America/New_York")).toBe("2026-02-27");
  });
  it("greets a 29 February birthday on the 28th in a year without one", () => {
    expect(birthdayKey(new Date("2026-02-28T10:00:00Z"), "UTC")).toMatchObject({ month: 2, day: 28, includeLeapDay: true });
    expect(birthdayKey(new Date("2028-02-28T10:00:00Z"), "UTC").includeLeapDay).toBe(false);
  });
  it("keeps every value as a bound parameter in the pool and the classification", () => {
    const campaign: AudienceCampaign = { id: "c1", kind: "automated", channel: "email", rule: { type: "recall", services: [{ serviceId: "x') or 1=1 --", intervalDays: 180 }] }, segmentFilter: null, serviceId: null };
    const query = dialect.sqlToQuery(classifySql(poolSql(campaign, context), campaign, context, { checkAlreadySent: true }));
    expect(query.sql).not.toContain("1=1");
    expect(query.params).toContain("x') or 1=1 --");
    // Recall catches people from the interval onwards, for a month.
    expect(query.sql).toContain("last_visit.at <=");
  });
  it("orders the reasons a customer is left out for, and counts who is left", () => {
    const result = summarise([
      { patient_id: "a", cycle: "", reason: null },
      { patient_id: "b", cycle: "", reason: "no_marketing_consent" },
      { patient_id: "c", cycle: "", reason: "no_marketing_consent" },
      { patient_id: "d", cycle: "", reason: "future_booking" },
      { patient_id: "e", cycle: "", reason: null },
    ], 1);
    expect(result).toMatchObject({ matching: 5, eligibleCount: 2, leftOut: { no_marketing_consent: 2, future_booking: 1, blocked: 0 } });
    expect(result.eligible).toEqual([{ patientId: "a", cycle: "" }]);
  });
  it("never lets a rule widen to everyone when it is missing", () => {
    const campaign: AudienceCampaign = { id: null, kind: "one_off", channel: "sms", rule: null, segmentFilter: { all: [{ field: "visits", op: "lt", value: 0 }] }, serviceId: null };
    const query = dialect.sqlToQuery(poolSql(campaign, context));
    expect(query.sql).toContain("visit_stats");
  });
});
