import { describe, expect, it } from "vitest";

import { defaultApprovalSettings } from "./approval";
import { defaultIntakeSettings } from "./booking-intake";
import { defaultBookingPageSettings } from "./booking-page";
import { defaultCancelPolicy } from "./cancel-policy";
import { type ServiceSetup } from "./service-setup";
import {
  assignTemplateInput, changedLockFields, hasLocalChanges, locationOptionsFor, patchFromTemplate, publishSentence, settingsFromSetup, touchedLockFields, updateTemplateInput,
} from "./service-templates";

const setup: ServiceSetup = {
  id: "svc1", version: 1,
  basics: { name: "Haircut", description: "A cut and finish.", category: null, bookingMode: "instant", requiredResourceKind: null, isActive: true, visibility: "listed", slug: "haircut", scheduleId: null, restrictionScheduleId: null, locationIds: ["a", "b"], practitionerIds: ["p1"] },
  timing: { bufferBeforeMinutes: 0, bufferAfterMinutes: 5, minimumNoticeMinutes: 60, window: { kind: "rolling_days", days: 60 }, slotIntervalMinutes: null, startOffsetMinutes: 0 },
  lengths: [{ minutes: 30, priceMinor: 40_000, isDefault: true }, { minutes: 60, priceMinor: 70_000, isDefault: false }],
  locationOptions: [{ kind: "in_person", locationId: "a", note: null }, { kind: "in_person", locationId: "b", note: null }],
  look: { colorLight: null, colorDark: null, bannerMediaId: null },
  bookingPage: defaultBookingPageSettings, intake: defaultIntakeSettings, approval: defaultApprovalSettings, cancelPolicy: defaultCancelPolicy,
};

describe("settingsFromSetup", () => {
  it("collapses in-person options into one kind and keeps the rest", () => {
    const settings = settingsFromSetup(setup);
    expect(settings.meeting).toEqual([{ kind: "in_person", note: null }]);
    expect(settings.lengths).toHaveLength(2);
  });

  it("is turned back into one in-person option per branch of a copy", () => {
    expect(locationOptionsFor([{ kind: "in_person", note: null }], ["x", "y"]).map((option) => option.locationId)).toEqual(["x", "y"]);
    expect(locationOptionsFor([{ kind: "video", note: "Link in the reminder" }], ["x", "y"])).toEqual([{ kind: "video", locationId: null, note: "Link in the reminder" }]);
  });
});

describe("touchedLockFields", () => {
  it("sees a changed price but ignores a patch that repeats what is stored, whatever the key order", () => {
    const same = { ...setup.timing, window: { days: 60, kind: "rolling_days" as const } };
    expect(touchedLockFields({ timing: same, lengths: [...setup.lengths].reverse() }, setup)).toEqual([]);
    expect(touchedLockFields({ lengths: setup.lengths.map((length) => ({ ...length, priceMinor: 1 })) }, setup)).toEqual(["lengths", "prices"]);
    expect(touchedLockFields({ basics: { description: "New words" } }, setup)).toEqual(["description"]);
    expect(touchedLockFields({ priceLabel: "₹5" }, setup)).toEqual(["prices"]);
    // The older booking-mode switch is an approval change in disguise.
    expect(touchedLockFields({ basics: { bookingMode: "request" } }, setup)).toEqual(["approval"]);
    expect(touchedLockFields({ basics: { bookingMode: "instant" } }, setup)).toEqual([]);
  });
});

describe("patchFromTemplate", () => {
  const template = { name: "Standard haircut", settings: { ...settingsFromSetup(setup), lengths: [{ minutes: 30, priceMinor: 50_000, isDefault: true }] } };

  it("carries only the locked fields", () => {
    const patch = patchFromTemplate(template, ["name", "prices"], setup);
    expect(patch.basics).toEqual({ name: "Standard haircut" });
    expect(patch.timing).toBeUndefined();
    // Only prices locked: the copy keeps its own lengths and takes the template's price where the minutes match.
    expect(patch.lengths).toEqual([{ minutes: 30, priceMinor: 50_000, isDefault: true }, { minutes: 60, priceMinor: 70_000, isDefault: false }]);
  });
});

describe("publishing", () => {
  const before = { name: "A", settings: settingsFromSetup(setup), lockedFields: ["prices" as const] };
  const after = { ...before, settings: { ...before.settings, lengths: before.settings.lengths.map((length) => ({ ...length, priceMinor: 99 })) } };

  it("names what changed among the locked fields", () => {
    expect(changedLockFields(before, after)).toEqual(["prices"]);
    expect(changedLockFields(before, { ...after, settings: { ...after.settings, description: "Other" } })).toEqual(["prices"]);
  });

  it("writes the sentence staff confirm", () => {
    expect(publishSentence({ changedFields: ["prices"], servicesUpdated: 12, servicesWithLocalChanges: 3, changesPrices: true }, { service: "service", services: "services" }))
      .toBe("Changes prices only on 12 services. 3 services have local changes to unlocked fields, which stay. Bookings already made keep the price they were booked at.");
    expect(publishSentence({ changedFields: [], servicesUpdated: 0, servicesWithLocalChanges: 0, changesPrices: false }, { service: "service", services: "services" })).toMatch(/No services use this template yet/);
  });

  it("counts local changes only in the unlocked fields", () => {
    const template = { name: "Haircut", settings: settingsFromSetup(setup), lockedFields: ["prices" as const] };
    expect(hasLocalChanges(template, setup)).toBe(false);
    expect(hasLocalChanges(template, { ...setup, basics: { ...setup.basics, description: "Mine" } })).toBe(true);
    expect(hasLocalChanges(template, { ...setup, lengths: setup.lengths.map((length) => ({ ...length, priceMinor: 1 })) })).toBe(false);
  });
});

describe("inputs", () => {
  it("needs something to change and something to assign", () => {
    expect(updateTemplateInput.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(assignTemplateInput.safeParse({}).success).toBe(false);
    expect(assignTemplateInput.safeParse({ locationIds: ["a"] }).success).toBe(true);
  });
});
