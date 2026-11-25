import { describe, expect, it } from "vitest";

import { recallDueDate, recallInput, waitlistStatusInput } from "./staff-operations";

describe("recallInput", () => {
  it("accepts a status, a due date, or both", () => {
    expect(recallInput.safeParse({ status: "booked" }).success).toBe(true);
    expect(recallInput.safeParse({ dueAt: "2026-10-05" }).success).toBe(true);
    expect(recallInput.safeParse({ status: "due", dueAt: "2026-10-05T09:00:00+05:30" }).success).toBe(true);
  });
  it("rejects an empty change, a bad date, a bad status and unknown fields", () => {
    expect(recallInput.safeParse({}).success).toBe(false);
    expect(recallInput.safeParse({ dueAt: "next week" }).success).toBe(false);
    expect(recallInput.safeParse({ status: "gone" }).success).toBe(false);
    expect(recallInput.safeParse({ status: "due", note: "x" }).success).toBe(false);
  });
  it("reads a bare date as 9 am clinic time", () => {
    expect(recallDueDate("2026-10-05").toISOString()).toBe("2026-10-05T03:30:00.000Z");
  });
});

describe("waitlistStatusInput", () => {
  it("accepts a status, dates or a time preference on their own", () => {
    expect(waitlistStatusInput.safeParse({ status: "fulfilled" }).success).toBe(true);
    expect(waitlistStatusInput.safeParse({ timePreference: "evening" }).success).toBe(true);
    expect(waitlistStatusInput.safeParse({ dateFrom: "2026-10-01", dateTo: "2026-10-09" }).success).toBe(true);
    expect(waitlistStatusInput.safeParse({ dateTo: "2026-10-09" }).success).toBe(true);
  });
  it("rejects an empty change, a reversed range, bad enums and unknown fields", () => {
    expect(waitlistStatusInput.safeParse({}).success).toBe(false);
    expect(waitlistStatusInput.safeParse({ dateFrom: "2026-10-09", dateTo: "2026-10-01" }).success).toBe(false);
    expect(waitlistStatusInput.safeParse({ timePreference: "night" }).success).toBe(false);
    expect(waitlistStatusInput.safeParse({ status: "paused" }).success).toBe(false);
    expect(waitlistStatusInput.safeParse({ status: "active", patientId: "x" }).success).toBe(false);
  });
});
