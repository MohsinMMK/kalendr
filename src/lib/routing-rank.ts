import type { AssignmentMode } from "@/lib/routing-contracts";

/** Team routing's ordering rules (feature 20), with no database so they can be tested hard. */

/** The practitioner id a page sends when the customer takes whoever is free. It is never stored on a booking. */
export const ANYONE = "anyone";

/** Days of bookings that count towards a person's share. */
export const FAIR_SHARE_DAYS = 30;

export interface RoutingCandidate {
  id: string;
  /** Higher goes first. */
  priority: number;
  /** Relative share of bookings: 2 takes twice as many as 1. */
  weight: number;
  /** Bookings taken for this service in the last `FAIR_SHARE_DAYS` days. */
  recentCount: number;
  /** When they were last given a booking, as epoch milliseconds. Null when never. */
  lastBookedAt: number | null;
  /** Joined the team recently: counted as having the team's average so they are not flooded. */
  isNew: boolean;
  /** Covers for a teammate who is away at this time: new "anyone" bookings go to them. */
  coversLeave: boolean;
}

export interface RankOptions {
  assignment: AssignmentMode;
  /** The person the customer saw last time, when the service asks to prefer them. Only used if they are in the list. */
  preferredId?: string | null;
}

/**
 * Orders people who are all free at the chosen time, best first. The order is:
 * the returning customer's own person, a cover person, highest priority (not for round robin), the person furthest
 * below their fair share, the person booked least recently, then the id so the result is always the same.
 * Pure on purpose: it is the part that is easy to get subtly wrong.
 */
export function rankAssignees(candidates: readonly RoutingCandidate[], options: RankOptions): string[] {
  return sortCandidates(candidates, options).map((entry) => entry.person.id);
}

interface Scored {
  person: RoutingCandidate;
  deficit: number;
}

function sortCandidates(candidates: readonly RoutingCandidate[], options: RankOptions): Scored[] {
  if (candidates.length === 0) return [];
  const settled = candidates.filter((person) => !person.isNew);
  const settledWeight = settled.reduce((sum, person) => sum + person.weight, 0);
  const settledCount = settled.reduce((sum, person) => sum + person.recentCount, 0);
  // Bookings per unit of weight across the people who have been here a while.
  const averagePerWeight = settledWeight > 0 ? settledCount / settledWeight : 0;
  const counted = candidates.map((person) => ({
    person,
    count: person.isNew ? Math.max(person.recentCount, averagePerWeight * person.weight) : person.recentCount,
  }));
  const totalWeight = counted.reduce((sum, entry) => sum + entry.person.weight, 0);
  const totalCount = counted.reduce((sum, entry) => sum + entry.count, 0);
  const scored = counted.map((entry) => ({
    person: entry.person,
    // How many bookings below their fair share they are, counting the one about to be given.
    deficit: (entry.person.weight / totalWeight) * (totalCount + 1) - entry.count,
  }));
  return scored.sort((a, b) => compareScored(a, b, options));
}

function compareScored(a: Scored, b: Scored, options: RankOptions): number {
  return firstDifference(a, b, options)?.order ?? 0;
}

type Reason = "returning_person" | "covering_leave" | "priority" | "fair_share" | "least_recent" | "order";

/** The first rule that separates two people, and which way it goes (negative: `a` first). */
function firstDifference(a: Scored, b: Scored, options: RankOptions): { reason: Reason; order: number } | null {
  if (options.preferredId) {
    const preferred = Number(b.person.id === options.preferredId) - Number(a.person.id === options.preferredId);
    if (preferred !== 0) return { reason: "returning_person", order: preferred };
  }
  const cover = Number(b.person.coversLeave) - Number(a.person.coversLeave);
  if (cover !== 0) return { reason: "covering_leave", order: cover };
  if (options.assignment !== "round_robin" && a.person.priority !== b.person.priority) return { reason: "priority", order: b.person.priority - a.person.priority };
  // Fractions this small are rounding noise, not a real difference in share.
  if (Math.abs(a.deficit - b.deficit) > 1e-9) return { reason: "fair_share", order: b.deficit - a.deficit };
  const lastA = a.person.lastBookedAt ?? -Infinity;
  const lastB = b.person.lastBookedAt ?? -Infinity;
  if (lastA !== lastB) return { reason: "least_recent", order: lastA < lastB ? -1 : 1 };
  const byId = a.person.id.localeCompare(b.person.id);
  return byId === 0 ? null : { reason: "order", order: byId };
}

const reasonText: Record<Reason | "only_free", string> = {
  only_free: "was the only person free at that time",
  returning_person: "was the person this customer saw last time",
  covering_leave: "was covering for a colleague who is away",
  priority: "has the highest priority for this service",
  fair_share: `had the fewest bookings in the last ${FAIR_SHARE_DAYS} days for their share`,
  least_recent: "was booked least recently",
  order: "was next in line",
};

/** Ranks like `rankAssignees` and says in plain words why the first person came first. */
export function explainAssignment(candidates: readonly RoutingCandidate[], options: RankOptions): { order: string[]; why: string } {
  const sorted = sortCandidates(candidates, options);
  const first = sorted[0];
  const second = sorted[1];
  if (!first) return { order: [], why: "" };
  const reason: Reason | "only_free" = second ? firstDifference(first, second, options)?.reason ?? "order" : "only_free";
  return { order: sorted.map((entry) => entry.person.id), why: reasonText[reason] };
}
