import { describe, expect, it } from "vitest";

import { bookerView, timeOffTabs } from "./time-off-panel";

const words = { provider: "stylist", service: "service" };

describe("bookerView", () => {
  it("shows the cover person's times and the public note", () => {
    expect(bookerView({ publicNote: "Back on 3 December", coverPractitionerId: "p2" }, "Asha", words)).toEqual({
      note: "“Back on 3 December”",
      times: "Shows Asha's times for the same service",
    });
  });

  it("says plainly when there is no note and no one covers", () => {
    expect(bookerView({ publicNote: null, coverPractitionerId: null }, null, words)).toEqual({
      note: "No note shown",
      times: "No stylist times are offered",
    });
  });
});

describe("timeOffTabs", () => {
  it("gives a person with a profile who cannot manage hours only their own", () => {
    expect(timeOffTabs("p1", false)).toEqual([{ value: "mine", label: "My time off" }]);
  });

  it("gives someone who manages hours and has a profile both their own and the team's", () => {
    expect(timeOffTabs("p1", true)).toEqual([{ value: "mine", label: "My time off" }, { value: "team", label: "Team time off" }]);
  });

  it("gives a login without a profile the team's", () => {
    expect(timeOffTabs(null, true)).toEqual([{ value: "team", label: "Team time off" }]);
    expect(timeOffTabs(null, false)).toEqual([{ value: "team", label: "Team time off" }]);
  });
});
