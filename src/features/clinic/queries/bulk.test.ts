import { describe, expect, it, vi } from "vitest";

import { bulkSummary, runBulk } from "./bulk";

describe("bulk changes", () => {
  it("keeps going when one visit is refused and says which one", async () => {
    const perform = vi.fn(async (id: string) => { if (id === "b") throw new Error("That time is taken"); });
    const outcome = await runBulk(["a", "b", "c"], perform, (error) => (error instanceof Error ? error.message : "failed"));
    expect(outcome.done).toEqual(["a", "c"]);
    expect(outcome.failed).toEqual([{ id: "b", message: "That time is taken" }]);
    expect(perform).toHaveBeenCalledTimes(3);
  });

  it("changes them one at a time, never together", async () => {
    let running = 0;
    let most = 0;
    await runBulk(["a", "b", "c"], async () => { running += 1; most = Math.max(most, running); await Promise.resolve(); running -= 1; }, () => "");
    expect(most).toBe(1);
  });

  it("summarises in plain words", () => {
    const verb = { past: "Cancelled", noun: "appointment", nounPlural: "appointments", couldNot: "could not be cancelled" };
    expect(bulkSummary({ done: ["a"], failed: [] }, verb)).toBe("Cancelled 1 appointment");
    expect(bulkSummary({ done: ["a", "b"], failed: [{ id: "c", message: "x" }] }, verb)).toBe("Cancelled 2. 1 could not be cancelled");
    expect(bulkSummary({ done: [], failed: [{ id: "c", message: "x" }] }, verb)).toBe("No appointments cancelled. 1 could not be cancelled");
  });
});
