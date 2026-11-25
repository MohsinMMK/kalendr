import { describe, expect, it } from "vitest";

import { ratingPageInputSchema } from "./rating-page";
import { defaultVisibility } from "./reviews";

describe("feedback rules", () => {
  it("starts 1 and 2 star scores as private and the rest as public", () => {
    expect([1, 2, 3, 4, 5].map(defaultVisibility)).toEqual(["private", "private", "public", "public", "public"]);
  });

  it("trims a comment and refuses a rating outside 1 to 5 or an unknown visibility", () => {
    expect(ratingPageInputSchema.parse({ rating: 4, comment: "  nice  " })).toMatchObject({ comment: "nice" });
    expect(ratingPageInputSchema.parse({ rating: 4, comment: "   " }).comment).toBeNull();
    expect(ratingPageInputSchema.safeParse({ rating: 6 }).success).toBe(false);
    expect(ratingPageInputSchema.safeParse({ rating: 3, visibility: "friends" }).success).toBe(false);
    expect(ratingPageInputSchema.safeParse({ comment: "x".repeat(1001) }).success).toBe(false);
  });
});
