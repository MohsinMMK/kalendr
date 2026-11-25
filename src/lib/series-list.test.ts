import { describe, expect, it } from "vitest";

import { bookingFilterSchema, bookingQueryFromParams, bookingQuerySchema, bookingQueryToParams, defaultSortFor, savedViewInputSchema, workspaceTabs } from "@/lib/bookings-list";
import { seriesListQuerySchema } from "@/lib/series-list";

describe("the Repeating tab's query", () => {
  it("is the fifth tab, and the booking query still refuses it", () => {
    expect(workspaceTabs).toEqual(["upcoming", "needs_approval", "past", "cancelled", "repeating"]);
    expect(bookingQuerySchema.safeParse({ tab: "repeating" }).success).toBe(false);
    expect(defaultSortFor("repeating")).toBe("asc");
  });

  it("reads the same address-bar words as the other tabs, with series statuses", () => {
    const params = new URLSearchParams("tab=repeating&q=meera&serviceIds=a,b&seriesStatuses=active,ended&sort=desc&limit=20");
    const parsed = seriesListQuerySchema.parse(bookingQueryFromParams(params));
    expect(parsed).toMatchObject({ q: "meera", serviceIds: ["a", "b"], seriesStatuses: ["active", "ended"], sort: "desc", limit: 20 });
    expect(seriesListQuerySchema.parse({}).sort).toBe("asc");
    expect(bookingQueryToParams({ seriesStatuses: ["ended"], q: "x" }).toString()).toBe("seriesStatuses=ended&q=x");
  });

  it("refuses values it does not know and never reads other tabs' filters as its own", () => {
    expect(seriesListQuerySchema.safeParse({ seriesStatuses: ["booked"] }).success).toBe(false);
    expect(seriesListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(seriesListQuerySchema.parse({ statuses: ["booked"], sources: ["online"] })).not.toHaveProperty("tab");
  });

  it("lets a saved view keep this tab and its status filter", () => {
    const view = savedViewInputSchema.parse({ name: "Ended courses", tab: "repeating", filters: { seriesStatuses: ["ended"] } });
    expect(view.tab).toBe("repeating");
    expect(bookingFilterSchema.parse(view.filters).seriesStatuses).toEqual(["ended"]);
    expect(savedViewInputSchema.safeParse({ name: "Bad one", tab: "nowhere", filters: {} }).success).toBe(false);
  });
});
