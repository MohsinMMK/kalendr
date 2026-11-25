import { describe, expect, it } from "vitest";

import { checklistKeys, dueOnboardingEmails, goLiveChecks, goLiveClear, resolveSteps, stepDefinitions, stepWords, summarise, type OnboardingFacts } from "./onboarding-steps";
import { profileWords, resolveBusinessProfile } from "./terminology";

const t = profileWords(resolveBusinessProfile({ businessType: "wellness" }));
const day = 86_400_000;
const facts = (overrides: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  marks: {}, activeTeamMembers: 1, activeReminderWorkflows: 3, hasLogoOrColour: false, paymentsConnected: false, ...overrides,
});
const done = (at = new Date(0)) => ({ doneAt: at, skippedAt: null });
const skipped = () => ({ doneAt: null, skippedAt: new Date(0) });

describe("the setup checklist", () => {
  it("has the eight steps in the order the owner meets them, with payments the only optional one", () => {
    expect(checklistKeys).toEqual(["services", "hours", "team", "test_booking", "reminders", "brand", "share_link", "payments"]);
    expect(checklistKeys.filter((key) => stepDefinitions[key].optional)).toEqual(["payments"]);
  });

  it("starts with reminders done (they come on with the template) and everything else to do", () => {
    const steps = resolveSteps(facts());
    expect(Object.fromEntries(steps.map((step) => [step.key, step.status]))).toEqual({
      services: "todo", hours: "todo", team: "todo", test_booking: "todo", reminders: "done", brand: "todo", share_link: "todo", payments: "todo",
    });
    expect(summarise(steps)).toMatchObject({ done: 1, skipped: 0, total: 8, next: "services", finished: false, halfDone: false });
  });

  it("finds automatic steps done from the business's data, once, and marks them as newly seen only until stored", () => {
    const found = resolveSteps(facts({ activeTeamMembers: 2, hasLogoOrColour: true, paymentsConnected: true }));
    expect(found.filter((step) => step.status === "done").map((step) => step.key)).toEqual(["team", "reminders", "brand", "payments"]);
    expect(found.filter((step) => step.newlyDetected).map((step) => step.key)).toEqual(["team", "reminders", "brand", "payments"]);
    const stored = resolveSteps(facts({ activeTeamMembers: 2, marks: { team: done(), reminders: done() } }));
    expect(stored.find((step) => step.key === "team")).toMatchObject({ status: "done", newlyDetected: false });
  });

  it("keeps a step done after the data changes (a logo removed later), because the owner did it", () => {
    const steps = resolveSteps(facts({ hasLogoOrColour: false, marks: { brand: done(new Date(5)) } }));
    expect(steps.find((step) => step.key === "brand")).toMatchObject({ status: "done", doneAt: new Date(5) });
  });

  it("takes manual steps only from a stored mark, so data alone never completes them", () => {
    expect(resolveSteps(facts()).find((step) => step.key === "services")?.status).toBe("todo");
    expect(resolveSteps(facts({ marks: { services: done() } })).find((step) => step.key === "services")?.status).toBe("done");
  });

  it("lets a skip stand until the step is really done, and a real finish beats a skip", () => {
    expect(resolveSteps(facts({ marks: { team: skipped() } })).find((step) => step.key === "team")?.status).toBe("skipped");
    expect(resolveSteps(facts({ activeTeamMembers: 3, marks: { team: skipped() } })).find((step) => step.key === "team")?.status).toBe("done");
  });

  it("knows when the owner has finished and when they are half way", () => {
    const allDone = Object.fromEntries(checklistKeys.map((key) => [key, done()]));
    expect(summarise(resolveSteps(facts({ marks: allDone }))).finished).toBe(true);
    const mixed = resolveSteps(facts({ marks: { services: done(), hours: done(), team: skipped(), test_booking: done(), brand: done(), share_link: done(), payments: skipped() } }));
    expect(summarise(mixed)).toMatchObject({ done: 6, skipped: 2, finished: true, halfDone: true, next: null });
    const half = summarise(resolveSteps(facts({ marks: { services: done(), hours: done(), team: done() } })));
    expect(half).toMatchObject({ done: 4, halfDone: true, finished: false });
  });

  it("words every step in the business's own terms", () => {
    for (const key of checklistKeys) {
      const words = stepWords(key, t);
      expect(words.title.length).toBeGreaterThan(3);
      expect(words.detail).not.toMatch(/patient|doctor|clinic/i);
    }
    expect(stepWords("services", t).title).toBe(`Confirm your ${t.services}`);
    expect(stepWords("payments", t).title).toContain("optional");
  });
});

describe("the go-live check", () => {
  const ready = { bookableServices: 3, peopleWithHours: 1, reminderChannelWorks: true, hasPhoneAndAddress: true, testRows: 0 };

  it("clears when nothing would embarrass the owner", () => {
    const checks = goLiveChecks(ready, t);
    expect(checks.map((check) => check.id)).toEqual(["services_bookable", "hours_set", "reminders_working", "contact_details", "test_data_present"]);
    expect(goLiveClear(checks)).toBe(true);
  });

  it("names each problem and where to fix it", () => {
    const checks = goLiveChecks({ bookableServices: 0, peopleWithHours: 0, reminderChannelWorks: false, hasPhoneAndAddress: false, testRows: 4 }, t);
    expect(goLiveClear(checks)).toBe(false);
    expect(checks.every((check) => !check.ok)).toBe(true);
    expect(checks.find((check) => check.id === "hours_set")?.fix).toEqual({ kind: "settings", section: "hours" });
    expect(checks.find((check) => check.id === "test_data_present")?.message).toMatch(/Remove them before you share/);
    expect(checks.find((check) => check.id === "services_bookable")?.message).toContain(t.services);
  });
});

describe("the onboarding email series", () => {
  const unfinished = summarise(resolveSteps(facts()));
  const finished = summarise(resolveSteps(facts({ marks: Object.fromEntries(checklistKeys.map((key) => [key, done()])) })));
  const half = summarise(resolveSteps(facts({ marks: { services: done(), hours: done(), team: done() } })));

  it("sends nothing before day 1", () => {
    expect(dueOnboardingEmails({ ageHours: 23, summary: unfinished, realBookings: 0 })).toEqual([]);
  });

  it("sends 'finish setting up' at day 1 to an owner under half done", () => {
    expect(dueOnboardingEmails({ ageHours: 24, summary: unfinished, realBookings: 0 })).toEqual(["onboarding_day1"]);
  });

  it("does not send it to an owner who has finished, or who is half way", () => {
    expect(dueOnboardingEmails({ ageHours: 30, summary: finished, realBookings: 0 })).not.toContain("onboarding_day1");
    expect(dueOnboardingEmails({ ageHours: 30, summary: half, realBookings: 0 })).not.toContain("onboarding_day1");
  });

  it("sends 'share your link' at day 3 only while there is no real booking", () => {
    expect(dueOnboardingEmails({ ageHours: 72, summary: finished, realBookings: 0 })).toEqual(["onboarding_day3"]);
    expect(dueOnboardingEmails({ ageHours: 72, summary: finished, realBookings: 1 })).toEqual([]);
    expect(dueOnboardingEmails({ ageHours: 80, summary: unfinished, realBookings: 0 })).toEqual(["onboarding_day1", "onboarding_day3"]);
  });

  it("leaves the day-11 trial email to the billing sweep", () => {
    expect(dueOnboardingEmails({ ageHours: 11 * 24, summary: unfinished, realBookings: 0 })).not.toContain("onboarding_day11");
    expect(day).toBe(86_400_000);
  });
});
