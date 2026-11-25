import { describe, expect, it } from "vitest";

import {
  bookingStepOrder,
  bookingSteps,
  nextStep,
  previousStep,
  stepForField,
  type BookingStepInput,
} from "./booking-steps";

const flags = [false, true] as const;

/** Every combination of the five conditions, with the numbers on both sides of their limits. */
function everyInput(): BookingStepInput[] {
  const inputs: BookingStepInput[] = [];
  for (const locationCount of [0, 1, 2, 3])
      for (const servicePreselected of flags)
        for (const eligiblePeopleCount of [0, 1, 2, 4])
          for (const hasForm of flags)
            inputs.push({ locationCount, servicePreselected, eligiblePeopleCount, hasForm });
  return inputs;
}

describe("bookingSteps", () => {
  it.each(everyInput())("shows only the screens that need an answer: %o", (input) => {
    const steps = bookingSteps(input);

    expect(steps.includes("visit-type" as never)).toBe(false);
    expect(steps.includes("location")).toBe(input.locationCount > 1);
    expect(steps.includes("service")).toBe(!input.servicePreselected);
    expect(steps.includes("provider")).toBe(input.eligiblePeopleCount > 1);
    expect(steps.includes("questions")).toBe(input.hasForm);
    // Time and details are always asked, and details is always last.
    expect(steps).toContain("time");
    expect(steps.at(-1)).toBe("details");
    // Screens keep their fixed order.
    const positions = steps.map((step) => bookingStepOrder.indexOf(step));
    expect(positions).toEqual([...positions].sort((first, second) => first - second));
  });

  it("asks a single-location business with one service list for three screens", () => {
    expect(
      bookingSteps({ locationCount: 1, servicePreselected: false, eligiblePeopleCount: 1, hasForm: false }),
    ).toEqual(["service", "time", "details"]);
  });

  it("asks everything when every condition applies", () => {
    expect(
      bookingSteps({ locationCount: 2, servicePreselected: false, eligiblePeopleCount: 3, hasForm: true }),
    ).toEqual(["location", "service", "provider", "time", "questions", "details"]);
  });

  it("skips the people screen for a profile link, however many people offer the service", () => {
    expect(
      bookingSteps({ locationCount: 2, servicePreselected: false, personPreselected: true, eligiblePeopleCount: 3, hasForm: false }),
    ).toEqual(["location", "service", "time", "details"]);
  });

  it("skips the service screen for a shared service link", () => {
    expect(
      bookingSteps({ locationCount: 1, servicePreselected: true, eligiblePeopleCount: 1, hasForm: false }),
    ).toEqual(["time", "details"]);
  });
});

describe("nextStep and previousStep", () => {
  const steps = bookingSteps({ locationCount: 2, servicePreselected: false, eligiblePeopleCount: 1, hasForm: false });

  it("moves through the shown screens in order", () => {
    expect(steps).toEqual(["location", "service", "time", "details"]);
    expect(nextStep(steps, "location")).toBe("service");
    expect(nextStep(steps, "service")).toBe("time");
    expect(nextStep(steps, "details")).toBeUndefined();
    expect(previousStep(steps, "time")).toBe("service");
    expect(previousStep(steps, "location")).toBeUndefined();
  });

  it("finds its way when the current screen has just been hidden", () => {
    // Choosing a service with one person hides the provider screen while it is open.
    expect(nextStep(steps, "provider")).toBe("time");
    expect(previousStep(steps, "provider")).toBe("service");
    expect(previousStep(steps, "questions")).toBe("time");
  });
});

describe("stepForField", () => {
  const all = bookingSteps({ locationCount: 2, servicePreselected: false, eligiblePeopleCount: 2, hasForm: true });
  const fewest = bookingSteps({ locationCount: 1, servicePreselected: true, eligiblePeopleCount: 1, hasForm: false });

  it.each([
    ["patientType", "service"],
    ["locationId", "location"],
    ["serviceId", "service"],
    ["practitionerId", "provider"],
    ["slotId", "time"],
    ["startsAt", "time"],
    ["endsAt", "time"],
    ["formAnswers.q1", "questions"],
    ["bookingFor", "details"],
    ["firstName", "details"],
    ["dateOfBirth", "details"],
    ["acceptedPrivacyNotice", "details"],
    ["somethingNew", "details"],
  ])("sends %s to the %s screen when every screen is shown", (field, step) => {
    expect(stepForField(field, all)).toBe(step);
  });

  it("sends errors on hidden screens to a screen that is shown", () => {
    expect(stepForField("practitionerId", fewest)).toBe("time");
    expect(stepForField("formAnswers.q1", fewest)).toBe("details");
    expect(stepForField("patientType", fewest)).toBe("time");
    expect(fewest).toContain(stepForField("locationId", fewest));
    expect(fewest).toContain(stepForField("serviceId", fewest));
  });
});

describe("length and meeting screens", () => {
  const input = { locationCount: 1, servicePreselected: false, eligiblePeopleCount: 1, hasForm: false };

  it("show only when the service has several lengths or a way of meeting that needs an answer", () => {
    expect(bookingSteps(input)).toEqual(["service", "time", "details"]);
    expect(bookingSteps({ ...input, hasLengths: true, hasMeet: true })).toEqual(["service", "length", "time", "meet", "details"]);
  });

  it("send errors to the screens that hold those fields", () => {
    const steps = bookingSteps({ ...input, hasLengths: true, hasMeet: true });
    expect(stepForField("durationMinutes", steps)).toBe("length");
    expect(stepForField("locationChoice", steps)).toBe("meet");
    expect(stepForField("locationChoice.detail", steps)).toBe("meet");
  });
});
