import { describe, expect, it } from "vitest";

import { photoProblem } from "./image-resize";

describe("photo checks", () => {
  it("accepts ordinary photos and rejects other files", () => {
    expect(photoProblem({ type: "image/jpeg", size: 1_000 })).toBeNull();
    expect(photoProblem({ type: "image/svg+xml", size: 1_000 })).toMatch(/JPEG/);
    expect(photoProblem({ type: "image/png", size: 11 * 1_024 * 1_024 })).toMatch(/10 MB/);
  });
});
