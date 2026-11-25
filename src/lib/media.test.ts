import { describe, expect, it } from "vitest";

import { isMediaKind, mediaIdFromUrl, mediaTargets, mediaUrl } from "./media";

describe("picture addresses", () => {
  it("knows the three kinds of business picture", () => {
    expect(isMediaKind("business_logo")).toBe(true);
    expect(isMediaKind("business_cover")).toBe(true);
    expect(isMediaKind("service")).toBe(true);
    expect(isMediaKind("staff")).toBe(false);
    expect(isMediaKind(undefined)).toBe(false);
  });

  it("builds an address under the business and reads the id back", () => {
    const url = mediaUrl("cedar hair/../x", "3f2c9d1e-0000-4000-8000-000000000001");
    expect(url).toBe("/api/public/media/cedar%20hair%2F..%2Fx/3f2c9d1e-0000-4000-8000-000000000001");
    expect(mediaIdFromUrl(url)).toBe("3f2c9d1e-0000-4000-8000-000000000001");
    expect(mediaIdFromUrl(`${url}?v=2`)).toBe("3f2c9d1e-0000-4000-8000-000000000001");
    expect(mediaIdFromUrl("")).toBeNull();
  });

  it("finds no stored picture behind the preview's sample drawings", () => {
    expect(mediaIdFromUrl("/demo/dental/logo.svg")).toBeNull();
    expect(mediaIdFromUrl("/api/public/media/")).toBeNull();
    expect(mediaIdFromUrl("https://example.com/api/public/media/a/b")).toBeNull();
  });

  it("keeps a square logo, a wide cover and a 4:3 service photo", () => {
    expect(mediaTargets.business_logo.width).toBe(mediaTargets.business_logo.height);
    expect(mediaTargets.business_cover.width / mediaTargets.business_cover.height).toBeCloseTo(16 / 9);
    expect(mediaTargets.service.width / mediaTargets.service.height).toBeCloseTo(4 / 3);
  });
});
