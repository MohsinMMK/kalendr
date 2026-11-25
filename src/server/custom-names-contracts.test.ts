import { describe, expect, it } from "vitest";

import { staffBusinessProfileSchema, staffCreateMemberSchema, staffSelfUpdateSchema, staffUpdateMemberSchema } from "./contracts";
import { workspaceLayoutSchema } from "@/lib/workspace-layout";

const base = { businessType: "wellness", terminology: {}, features: {} } as const;

describe("role names in the business profile", () => {
  it("accepts renamed roles and trims them", () => {
    const parsed = staffBusinessProfileSchema.parse({ ...base, roleNames: { receptionist: "  Front desk ", practitioner: "Team" } });
    expect(parsed.roleNames).toEqual({ receptionist: "Front desk", practitioner: "Team" });
  });

  it("leaves roleNames out when it is not sent, so stored names stay", () => {
    expect(staffBusinessProfileSchema.parse(base).roleNames).toBeUndefined();
  });

  it("refuses an unknown role and a name over 40 characters", () => {
    expect(staffBusinessProfileSchema.safeParse({ ...base, roleNames: { janitor: "Janitor" } }).success).toBe(false);
    expect(staffBusinessProfileSchema.safeParse({ ...base, roleNames: { owner: "x".repeat(41) } }).success).toBe(false);
  });
});

describe("a person's job title", () => {
  it("is changed on its own, without touching access", () => {
    expect(staffUpdateMemberSchema.parse({ jobTitle: " Senior stylist " })).toEqual({ jobTitle: "Senior stylist" });
  });

  it("clears with blank or null", () => {
    expect(staffUpdateMemberSchema.parse({ jobTitle: "   " })).toEqual({ jobTitle: null });
    expect(staffUpdateMemberSchema.parse({ jobTitle: null })).toEqual({ jobTitle: null });
    expect(staffSelfUpdateSchema.parse({ jobTitle: "" })).toEqual({ jobTitle: null });
  });

  it("stops at 80 characters", () => {
    expect(staffUpdateMemberSchema.safeParse({ jobTitle: "x".repeat(81) }).success).toBe(false);
    expect(staffSelfUpdateSchema.safeParse({ jobTitle: "x".repeat(81) }).success).toBe(false);
  });

  it("is one line: line breaks and control characters become one space", () => {
    expect(staffSelfUpdateSchema.parse({ jobTitle: "Senior\n\nstylist\u0000lead" })).toEqual({ jobTitle: "Senior stylist lead" });
  });

  it("can come with an invite, and is optional there", () => {
    const invite = { name: "Asha Rao", email: "asha@example.com", role: "receptionist" } as const;
    expect(staffCreateMemberSchema.parse(invite)).toEqual(invite);
    expect(staffCreateMemberSchema.parse({ ...invite, jobTitle: "Front desk lead" }).jobTitle).toBe("Front desk lead");
  });

  it("is not enough for an update to be empty", () => {
    expect(staffUpdateMemberSchema.safeParse({}).success).toBe(false);
  });
});

describe("the sidebar on the workspace layout", () => {
  it("is carried by the layout schema under its page id, names and all", () => {
    const layout = { pages: { sidebar: { lists: { entries: { order: ["schedule", "patients"], hidden: ["offers"] } }, options: { "name-schedule": "Diary", "heading-front-desk": "Reception" } } } };
    expect(workspaceLayoutSchema.parse(layout)).toEqual(layout);
  });
});
