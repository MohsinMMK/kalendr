import { describe, expect, it } from "vitest";

import { clinicSetupState, nextSetupLabel } from "./clinic-setup";
import { profileWords, resolveBusinessProfile } from "./terminology";

describe("clinic setup completeness", () => {
  it("does not count inactive services, or hours on an unrelated practitioner, as booking readiness", () => {
    const state = clinicSetupState({
      slug: "lotus",
      services: [
        { resourceKind: "chair", isActive: false },
        { practitionerIds: ["p1"], locationIds: ["loc1"] },
      ],
      practitioners: [
        { id: "p1", locationIds: ["loc1"] },
        { id: "p2", locationIds: ["loc1"] },
      ],
      resources: [],
      practitionerIdsWithHours: ["p2"],
    });
    expect(state.missing).toEqual(["hours"]);
    const unlinked = clinicSetupState({
      slug: "lotus",
      services: [{ practitionerIds: [], locationIds: ["loc1"] }],
      practitioners: [{ id: "p1", locationIds: ["loc1"] }],
      resources: [],
      practitionerIdsWithHours: ["p1"],
    });
    expect(unlinked.missing).toEqual(["assignment"]);
    expect(unlinked.complete).toBe(false);
  });
  it("requires an active room at the service location", () => {
    const state = clinicSetupState({
      slug: "lotus",
      services: [
        {
          resourceKind: "chair",
          practitionerIds: ["p1"],
          locationIds: ["loc1"],
        },
      ],
      practitioners: [{ id: "p1", locationIds: ["loc1"] }],
      resources: [
        { kind: "chair", locationId: "loc2" },
        { kind: "chair", locationId: "loc1", isActive: false },
      ],
      practitionerIdsWithHours: ["p1"],
    });
    expect(state.missing).toEqual(["resource"]);
  });
  it("requires a service, matching rooms, a doctor, and hours before the clinic is ready", () => {
    const empty = clinicSetupState({
      slug: "new-clinic",
      services: [],
      practitioners: [],
      resources: [],
      practitionerIdsWithHours: [],
    });
    expect(empty.complete).toBe(false);
    expect(empty.missing).toEqual(["service", "practitioner"]);
    expect(empty.bookingPath).toBe("/book/new-clinic");
    expect(nextSetupLabel(empty.missing)).toBe(
      "Add a service patients can book",
    );

    const chairService = clinicSetupState({
      slug: "new-clinic",
      services: [{ resourceKind: "chair" }],
      practitioners: [{ id: "p1" }],
      resources: [{ kind: "room" }],
      practitionerIdsWithHours: [],
    });
    expect(chairService.missing).toEqual(["resource", "hours"]);

    const ready = clinicSetupState({
      slug: "new-clinic",
      services: [{ resourceKind: "chair" }],
      practitioners: [{ id: "p1" }],
      resources: [{ kind: "chair" }],
      practitionerIdsWithHours: ["p1"],
    });
    expect(ready.complete).toBe(true);
    expect(ready.missing).toEqual([]);
  });

  it("names the next step in the business's own words", () => {
    const t = profileWords(resolveBusinessProfile({ businessType: "real_estate" }));
    expect(nextSetupLabel(["service"], t, false)).toBe(`Add ${t.aService} clients can book`);
    expect(nextSetupLabel(["practitioner"], t, false)).toBe("Add an agent");
    expect(nextSetupLabel([], t, false)).toBe("Finish setup");
  });
});
