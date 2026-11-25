import { describe, expect, it } from "vitest";

import { explainAssignment, rankAssignees, type RoutingCandidate } from "@/lib/routing-rank";

const person = (id: string, over: Partial<RoutingCandidate> = {}): RoutingCandidate => ({
  id, priority: 0, weight: 1, recentCount: 0, lastBookedAt: null, isNew: false, coversLeave: false, ...over,
});

/** Gives out `bookings` in turn the way the booking transaction does, feeding each result back as a booking. */
function simulate(people: RoutingCandidate[], bookings: number, assignment: "any_available" | "round_robin" = "any_available"): Record<string, number> {
  const state = people.map((entry) => ({ ...entry }));
  const tally: Record<string, number> = Object.fromEntries(people.map((entry) => [entry.id, 0]));
  for (let turn = 1; turn <= bookings; turn += 1) {
    const [winner] = rankAssignees(state, { assignment });
    const chosen = state.find((entry) => entry.id === winner)!;
    chosen.recentCount += 1;
    chosen.lastBookedAt = turn;
    tally[winner!] += 1;
  }
  return tally;
}

describe("rankAssignees", () => {
  it("returns nothing for nobody", () => {
    expect(rankAssignees([], { assignment: "any_available" })).toEqual([]);
  });

  it("puts the higher priority first even when they are over their share", () => {
    const order = rankAssignees([person("a", { priority: 1, recentCount: 50 }), person("b", { priority: 5 }), person("c")], { assignment: "any_available" });
    expect(order).toEqual(["b", "a", "c"]);
  });

  it("ignores priority for round robin and goes by share", () => {
    const order = rankAssignees([person("a", { priority: 9, recentCount: 4 }), person("b", { priority: 0, recentCount: 1 })], { assignment: "round_robin" });
    expect(order[0]).toBe("b");
  });

  it("takes the person furthest below their fair share among equals", () => {
    const order = rankAssignees([person("a", { recentCount: 6 }), person("b", { recentCount: 2 }), person("c", { recentCount: 4 })], { assignment: "any_available" });
    expect(order).toEqual(["b", "c", "a"]);
  });

  it("measures fair share against weight, not the raw count", () => {
    // a has weight 2 and 6 bookings (3 per weight); b has weight 1 and 4 (4 per weight), so a is further below.
    const order = rankAssignees([person("b", { recentCount: 4 }), person("a", { weight: 2, recentCount: 6 })], { assignment: "any_available" });
    expect(order[0]).toBe("a");
  });

  it("breaks a tie by who was booked longest ago, and a never-booked person goes first", () => {
    const order = rankAssignees([person("a", { lastBookedAt: 300 }), person("b", { lastBookedAt: 100 }), person("c", { lastBookedAt: null, recentCount: 0 })], { assignment: "any_available" });
    expect(order).toEqual(["c", "b", "a"]);
  });

  it("breaks a complete tie by id so the answer never changes", () => {
    expect(rankAssignees([person("b"), person("a")], { assignment: "any_available" })).toEqual(["a", "b"]);
    expect(rankAssignees([person("a"), person("b")], { assignment: "any_available" })).toEqual(["a", "b"]);
  });

  it("gives a returning customer their own person first when they are free", () => {
    const order = rankAssignees([person("a", { priority: 9 }), person("b")], { assignment: "any_available", preferredId: "b" });
    expect(order[0]).toBe("b");
  });

  it("ignores a preferred person who is not in the free list", () => {
    expect(rankAssignees([person("a"), person("b")], { assignment: "any_available", preferredId: "z" })).toEqual(["a", "b"]);
  });

  it("sends new bookings to a cover person while their teammate is away", () => {
    const order = rankAssignees([person("a", { priority: 9 }), person("b", { coversLeave: true, recentCount: 30 })], { assignment: "any_available" });
    expect(order[0]).toBe("b");
  });

  it("counts a new team member as having the team's average so they are not flooded", () => {
    const order = rankAssignees([person("old1", { recentCount: 10 }), person("old2", { recentCount: 10 }), person("fresh", { isNew: true, recentCount: 0 })], { assignment: "any_available" });
    // fresh is treated as 10, so nobody is ahead of them and the tie goes to the id rather than to the empty count.
    expect(order[0]).toBe("fresh");
    expect(simulate([person("old1", { recentCount: 10 }), person("old2", { recentCount: 10 }), person("fresh", { isNew: true })], 30).fresh).toBeLessThanOrEqual(11);
  });

  it("does not let a new member who has had a lot of bookings drop below their real count", () => {
    const order = rankAssignees([person("old", { recentCount: 2 }), person("fresh", { isNew: true, recentCount: 9 })], { assignment: "any_available" });
    expect(order[0]).toBe("old");
  });

  it("spreads thirty bookings in line with weights 2:1:1", () => {
    const tally = simulate([person("a", { weight: 2 }), person("b"), person("c")], 30);
    expect(tally.a).toBeGreaterThanOrEqual(14);
    expect(tally.a).toBeLessThanOrEqual(16);
    expect(Math.abs(tally.b - 7.5)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(tally.c - 7.5)).toBeLessThanOrEqual(1.5);
    expect(tally.a + tally.b + tally.c).toBe(30);
  });

  it("rotates evenly with equal weights", () => {
    const tally = simulate([person("a"), person("b"), person("c")], 30);
    expect(tally).toEqual({ a: 10, b: 10, c: 10 });
  });

  it("catches up a person who starts well behind", () => {
    const tally = simulate([person("a", { recentCount: 10 }), person("b", { recentCount: 0 })], 10);
    expect(tally.b).toBeGreaterThanOrEqual(9);
  });
});

describe("explainAssignment (routing forms)", () => {
  it("ranks exactly like rankAssignees and says why the first person won", () => {
    const people = [person("a", { recentCount: 5 }), person("b", { recentCount: 1 }), person("c", { recentCount: 3 })];
    const options = { assignment: "any_available" as const };
    const result = explainAssignment(people, options);
    expect(result.order).toEqual(rankAssignees(people, options));
    expect(result.order[0]).toBe("b");
    expect(result.why).toContain("fewest bookings");
  });

  it("names the only free person, the priority rule and a returning customer", () => {
    expect(explainAssignment([person("a")], { assignment: "any_available" }).why).toContain("only person free");
    expect(explainAssignment([person("a"), person("b", { priority: 5 })], { assignment: "any_available" }).why).toContain("priority");
    expect(explainAssignment([person("a"), person("b")], { assignment: "any_available", preferredId: "b" }).why).toContain("saw last time");
  });

  it("gives a heavier-weighted person a bigger share, which is how attribute weights take effect", () => {
    const people = [person("junior", { weight: 1, recentCount: 2 }), person("senior", { weight: 2, recentCount: 2 })];
    expect(explainAssignment(people, { assignment: "round_robin" }).order[0]).toBe("senior");
  });
});
