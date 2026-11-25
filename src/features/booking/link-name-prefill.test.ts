import { describe, expect, it } from "vitest";

import { readLinkDetails } from "./booking-answers";

describe("?name= link prefill", () => {
  it("splits a full name with the last word as the last name", () => {
    expect(readLinkDetails({ name: "Juan Carlos de la Cruz" })).toMatchObject({ firstName: "Juan Carlos de la", lastName: "Cruz" });
  });

  it("accepts a one-word name", () => {
    const details = readLinkDetails({ name: "Priya" });
    expect(details.firstName).toBe("Priya");
    expect(details.lastName).toBe("");
  });

  it("ignores a name that is too short", () => {
    expect(readLinkDetails({ name: "P" }).firstName).toBeUndefined();
  });
});
