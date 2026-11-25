/**
 * Which booking screens a customer sees. Only the screens that need an
 * answer are shown; everything else is filled in silently.
 */

export const bookingStepOrder = [
  "location",
  "service",
  "length",
  "provider",
  "time",
  "meet",
  "questions",
  "details",
] as const;

export type BookingStepId = (typeof bookingStepOrder)[number];

export interface BookingStepInput {
  /** Active locations the customer can choose from. */
  locationCount: number;
  /** A valid service came with the link (`?service=`) and is still chosen. */
  servicePreselected: boolean;
  /** A person came with the link (`?person=`) and still fits the chosen service and location. */
  personPreselected?: boolean;
  /** People who offer the chosen service at the chosen location. */
  eligiblePeopleCount: number;
  /** The chosen service can be booked for more than one length. */
  hasLengths?: boolean;
  /** The chosen service offers a choice of how to meet, or one that needs an answer (the customer's address). */
  hasMeet?: boolean;
  /** The chosen service has the business's own booking questions. */
  hasForm: boolean;
}

export function bookingSteps(input: BookingStepInput): BookingStepId[] {
  const shown: Record<BookingStepId, boolean> = {
    location: input.locationCount > 1,
    service: !input.servicePreselected,
    length: input.hasLengths === true,
    provider: !input.personPreselected && input.eligiblePeopleCount > 1,
    time: true,
    meet: input.hasMeet === true,
    questions: input.hasForm,
    details: true,
  };
  return bookingStepOrder.filter((step) => shown[step]);
}

/** The step after `current`, or undefined on the last one. */
export function nextStep(steps: readonly BookingStepId[], current: BookingStepId): BookingStepId | undefined {
  const index = steps.indexOf(current);
  if (index === -1) {
    // The current screen is no longer shown: go to the first shown screen after it.
    const order = bookingStepOrder.indexOf(current);
    return steps.find((step) => bookingStepOrder.indexOf(step) > order);
  }
  return steps[index + 1];
}

/** The step before `current`, or undefined on the first one. */
export function previousStep(steps: readonly BookingStepId[], current: BookingStepId): BookingStepId | undefined {
  const index = steps.indexOf(current);
  if (index === -1) {
    const order = bookingStepOrder.indexOf(current);
    return [...steps].reverse().find((step) => bookingStepOrder.indexOf(step) < order);
  }
  return index > 0 ? steps[index - 1] : undefined;
}

const fieldSteps: Record<string, BookingStepId> = {
  patientType: "service",
  locationId: "location",
  serviceId: "service",
  practitionerId: "provider",
  durationMinutes: "length",
  locationChoice: "meet",
  slotId: "time",
  startsAt: "time",
  endsAt: "time",
};

/**
 * The screen that holds a field, so an error from the server can send the
 * customer straight to it. A field on a hidden screen falls to the next shown
 * screen that can fix it.
 */
export function stepForField(field: string, steps: readonly BookingStepId[]): BookingStepId {
  if (field.startsWith("formAnswers.")) {
    return steps.includes("questions") ? "questions" : "details";
  }
  const step = fieldSteps[field.startsWith("locationChoice") ? "locationChoice" : field] ?? "details";
  if (steps.includes(step)) return step;
  // A hidden choice is made for the customer; the time screen is where it can still change.
  if (step === "provider") return "time";
  return steps[0] ?? "details";
}
