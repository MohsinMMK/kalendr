import { describe, expect, it } from "vitest";

import {
  isReviewWindowOpen,
  reviewClosesAt,
  reviewDisplayName,
  reviewInputSchema,
  summarizeRatings,
} from "@/lib/reviews";

describe("review display names", () => {
  it("keeps the first name and the last initial only", () => {
    expect(reviewDisplayName("Sam", "Kapoor")).toBe("Sam K.");
    expect(reviewDisplayName("  Mary Ann ", " o'neil")).toBe("Mary O.");
  });

  it("still gives a name when parts are missing", () => {
    expect(reviewDisplayName("Sam", "")).toBe("Sam");
    expect(reviewDisplayName("", "")).toBe("Customer");
  });
});

describe("rating summaries", () => {
  it("averages every review, and has no average with none", () => {
    expect(summarizeRatings([])).toEqual({ count: 0, average: null });
    expect(summarizeRatings([4])).toEqual({ count: 1, average: 4 });
    expect(summarizeRatings([5, 4])).toEqual({ count: 2, average: 4.5 });
    expect(summarizeRatings([5, 5, 5, 5, 4])).toEqual({ count: 5, average: 4.8 });
  });

  it("rounds the average to one decimal", () => {
    expect(summarizeRatings([5, 4, 4])).toEqual({ count: 3, average: 4.3 });
    expect(summarizeRatings([5, 5, 5, 4])).toEqual({ count: 4, average: 4.8 });
  });
});

describe("review window", () => {
  const endsAt = new Date("2026-10-01T10:00:00.000Z");

  it("opens only for finished appointments", () => {
    expect(isReviewWindowOpen("completed", endsAt, new Date("2026-10-02T00:00:00.000Z"))).toBe(true);
    for (const status of ["requested", "booked", "checked_in", "cancelled", "no_show", "entered_in_error"]) {
      expect(isReviewWindowOpen(status, endsAt, new Date("2026-10-02T00:00:00.000Z"))).toBe(false);
    }
  });

  it("closes 60 days after the appointment ends", () => {
    expect(reviewClosesAt(endsAt).toISOString()).toBe("2026-11-30T10:00:00.000Z");
    expect(isReviewWindowOpen("completed", endsAt, new Date("2026-11-30T10:00:00.000Z"))).toBe(true);
    expect(isReviewWindowOpen("completed", endsAt, new Date("2026-11-30T10:00:01.000Z"))).toBe(false);
  });
});

describe("review input", () => {
  it("accepts a whole rating from 1 to 5 and trims the comment", () => {
    expect(reviewInputSchema.parse({ rating: 5, comment: "  Lovely  " })).toEqual({ rating: 5, comment: "Lovely" });
    expect(reviewInputSchema.parse({ rating: 1 })).toEqual({ rating: 1, comment: null });
    expect(reviewInputSchema.parse({ rating: 3, comment: "   " })).toEqual({ rating: 3, comment: null });
  });

  it("refuses other ratings and long comments", () => {
    expect(reviewInputSchema.safeParse({ rating: 0 }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ rating: 6 }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ rating: 4.5 }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ rating: 4, comment: "x".repeat(1001) }).success).toBe(false);
  });
});

describe("preview sample reviews", () => {
  it("belong to sample team members and services and give an average", async () => {
    const { previewReviews } = await import("@/lib/preview-reviews");
    const { demoPractitioners, demoServices } = await import("@/lib/demo-data");
    const people = new Set(demoPractitioners.map((person) => person.id));
    const services = new Set(demoServices.map((service) => service.id));
    for (const review of previewReviews) {
      expect(people.has(review.practitionerId)).toBe(true);
      expect(services.has(review.serviceId)).toBe(true);
      expect(reviewInputSchema.safeParse({ rating: review.rating, comment: review.comment ?? undefined }).success).toBe(true);
    }
    expect(summarizeRatings(previewReviews.map((review) => review.rating)).average).not.toBeNull();
  });
});
