import { describe, expect, it } from "vitest";

import { roleCanOpenRecords, savedPeople, type PortalVisit } from "./visit-records";

describe("who can open records", () => {
  it.each(["owner", "admin", "practitioner"])("allows %s", (role) => expect(roleCanOpenRecords(role)).toBe(true));
  it.each(["receptionist", "billing", "read_only", ""])("refuses %j", (role) => expect(roleCanOpenRecords(role)).toBe(false));
});

describe("people to book again", () => {
  const now = Date.parse("2026-06-01T00:00:00Z");
  const visit = (overrides: Partial<PortalVisit>): PortalVisit => ({
    id: "v", clinicSlug: "smile", clinicName: "Smile", patientId: "p1", serviceName: "Cleaning", practitionerName: "Mira Sen",
    practitionerId: "mira", serviceId: "cleaning", locationName: "Main", startsAt: "2026-05-01T10:00:00Z", timezone: "UTC", status: "completed", href: null,
    ...overrides,
  });

  it("counts the visits that took place and remembers the latest service", () => {
    const [mira, rohan] = savedPeople([
      visit({ id: "a", startsAt: "2026-03-01T10:00:00Z" }),
      visit({ id: "b", startsAt: "2026-05-01T10:00:00Z", serviceId: "whitening", serviceName: "Whitening" }),
      visit({ id: "c", startsAt: "2026-04-01T10:00:00Z", status: "cancelled" }),
      visit({ id: "d", startsAt: "2026-04-02T10:00:00Z", status: "no_show" }),
      visit({ id: "e", practitionerId: "rohan", practitionerName: "Rohan Shah", startsAt: "2026-02-01T10:00:00Z" }),
    ], now);
    expect(mira).toMatchObject({ key: "smile/mira", visits: 2, lastVisitAt: "2026-05-01T10:00:00Z", lastServiceId: "whitening", lastServiceName: "Whitening", nextVisitAt: null });
    expect(rohan).toMatchObject({ id: "rohan", visits: 1 });
  });

  it("lists someone who is only booked ahead, after the people already seen", () => {
    const people = savedPeople([
      visit({ id: "a", practitionerId: "asha", practitionerName: "Asha Rao", startsAt: "2026-06-20T10:00:00Z", status: "booked" }),
      visit({ id: "b", practitionerId: "asha", practitionerName: "Asha Rao", startsAt: "2026-06-10T10:00:00Z", status: "requested" }),
      visit({ id: "c" }),
    ], now);
    expect(people.map((person) => person.id)).toEqual(["mira", "asha"]);
    expect(people[1]).toMatchObject({ visits: 0, lastVisitAt: null, nextVisitAt: "2026-06-10T10:00:00Z" });
  });

  it("keeps the same person at two businesses apart and leaves out cancelled-only people", () => {
    const people = savedPeople([
      visit({ id: "a" }),
      visit({ id: "b", clinicSlug: "glow", clinicName: "Glow" }),
      visit({ id: "c", practitionerId: "rohan", status: "cancelled" }),
      visit({ id: "d", practitionerId: undefined }),
    ], now);
    expect(people.map((person) => person.key).sort()).toEqual(["glow/mira", "smile/mira"]);
  });
});
