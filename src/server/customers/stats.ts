/** Pure customer figures, so they are tested without a database. No "server-only": screens and the worker may use them. */

const DAY_MS = 86_400_000;

/** Average whole-or-half days between consecutive visits, or null with fewer than two. Order does not matter. */
export function averageGapDays(visits: readonly Date[]): number | null {
  if (visits.length < 2) return null;
  const sorted = visits.map((visit) => visit.getTime()).sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return null;
  return Math.round(((last - first) / (sorted.length - 1) / DAY_MS) * 10) / 10;
}
