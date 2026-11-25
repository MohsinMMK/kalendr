import { describe, expect, it } from "vitest";

import { activeBusinessCookie, chooseMembership, readActiveBusinessSlug, switchBusinessSchema } from "./active-business";

describe("readActiveBusinessSlug", () => {
  it("reads the slug among other cookies", () => {
    expect(readActiveBusinessSlug(`theme=dark; ${activeBusinessCookie}=north-clinic; sidebar_state=true`)).toBe("north-clinic");
  });

  it("reads a quoted or percent-encoded value", () => {
    expect(readActiveBusinessSlug(`${activeBusinessCookie}="north-clinic"`)).toBe("north-clinic");
    expect(readActiveBusinessSlug(`${activeBusinessCookie}=north%2Dclinic`)).toBe("north-clinic");
  });

  it("is null when there is no cookie or no header", () => {
    expect(readActiveBusinessSlug(null)).toBeNull();
    expect(readActiveBusinessSlug(undefined)).toBeNull();
    expect(readActiveBusinessSlug("")).toBeNull();
    expect(readActiveBusinessSlug("theme=dark")).toBeNull();
  });

  it("does not match a cookie whose name only ends the same way", () => {
    expect(readActiveBusinessSlug(`other_${activeBusinessCookie}=north-clinic`)).toBeNull();
  });

  it("ignores anything that is not a well-formed slug", () => {
    for (const value of ["", "A", "North Clinic", "north_clinic", "-north", "north-", "a".repeat(81), "%E0%A4%A", "..%2F..", "x'; drop table tenants;--"]) {
      expect(readActiveBusinessSlug(`${activeBusinessCookie}=${value}`), value).toBeNull();
    }
  });

  it("takes the first of two cookies with the same name", () => {
    expect(readActiveBusinessSlug(`${activeBusinessCookie}=first-one; ${activeBusinessCookie}=second-one`)).toBe("first-one");
  });
});

describe("chooseMembership", () => {
  const memberships = [{ slug: "alpha" }, { slug: "beta" }, { slug: "gamma" }];

  it("opens the first business when nothing is asked for", () => {
    expect(chooseMembership(memberships, {})?.slug).toBe("alpha");
  });

  it("opens the remembered business when the person is still in it", () => {
    expect(chooseMembership(memberships, { cookieSlug: "gamma" })?.slug).toBe("gamma");
  });

  it("silently ignores a remembered business the person is not in", () => {
    expect(chooseMembership(memberships, { cookieSlug: "elsewhere" })?.slug).toBe("alpha");
  });

  it("lets a slug asked for by name beat the cookie", () => {
    expect(chooseMembership(memberships, { requestedSlug: "beta", cookieSlug: "gamma" })?.slug).toBe("beta");
  });

  it("never falls back when a named slug does not match", () => {
    expect(chooseMembership(memberships, { requestedSlug: "elsewhere", cookieSlug: "gamma" })).toBeUndefined();
  });

  it("finds nothing for a person with no business", () => {
    expect(chooseMembership([], { cookieSlug: "alpha" })).toBeUndefined();
  });
});

describe("switchBusinessSchema", () => {
  it("accepts a slug and refuses anything else", () => {
    expect(switchBusinessSchema.safeParse({ slug: "north-clinic" }).success).toBe(true);
    expect(switchBusinessSchema.safeParse({ slug: "North Clinic" }).success).toBe(false);
    expect(switchBusinessSchema.safeParse({}).success).toBe(false);
  });
});
