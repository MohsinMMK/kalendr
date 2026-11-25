import { describe, expect, it } from "vitest";

import { defaultCondition, describeFilter, segmentFieldOrder, segmentFilterSchema } from "./segment-filter";

describe("segment filter", () => {
  it("accepts the three-condition example and reads it back in plain words", () => {
    const filter = segmentFilterSchema.parse({ all: [
      { field: "lastVisit", op: "olderThanDays", days: 90 },
      { field: "visits", op: "gt", value: 3 },
      { field: "marketingConsent", value: true },
    ] });
    expect(describeFilter(filter)).toBe("No visit in 90 days, and more than 3 visits, and agreed to marketing messages");
  });

  it("refuses unknown fields, extra keys and incomplete conditions", () => {
    expect(segmentFilterSchema.safeParse({ all: [{ field: "password", value: 1 }] }).success).toBe(false);
    expect(segmentFilterSchema.safeParse({ all: [{ field: "visits", op: "gt", value: 3, extra: 1 }] }).success).toBe(false);
    expect(segmentFilterSchema.safeParse({ all: [{ field: "lastVisit", op: "olderThanDays" }] }).success).toBe(false);
    expect(segmentFilterSchema.safeParse({ all: [{ field: "tag", op: "has", tagIds: [] }] }).success).toBe(false);
    expect(segmentFilterSchema.safeParse({ all: Array.from({ length: 13 }, () => ({ field: "futureBooking", value: true })) }).success).toBe(false);
  });

  it("describes an empty filter as everyone and names services and tags with the names it is given", () => {
    expect(describeFilter({ all: [] })).toBe("Everyone");
    const text = describeFilter({ all: [{ field: "service", op: "used", serviceIds: ["s1"] }, { field: "tag", op: "hasNot", tagIds: ["t1", "t2", "t3"] }, { field: "spend", op: "gte", valueMinor: 200000 }] }, {
      serviceName: () => "Cleaning", tagName: (id) => ({ t1: "VIP", t2: "Staff", t3: "Local" })[id] ?? "", money: (minor) => `₹${minor / 100}`,
    });
    expect(text).toBe("Has had Cleaning, and not tagged VIP, Staff or 1 more, and has spent at least ₹2000");
  });

  it("gives every field a starting condition that is valid once its choices are made", () => {
    for (const field of segmentFieldOrder) {
      const condition = defaultCondition(field);
      const parsed = segmentFilterSchema.safeParse({ all: [condition] });
      if (field === "service" || field === "tag") expect(parsed.success).toBe(false);
      else expect(parsed.success, field).toBe(true);
    }
  });
});
