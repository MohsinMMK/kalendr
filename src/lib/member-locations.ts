/**
 * How a team member's location limit reads on screen. No ids means every location (the default), so it says nothing; one
 * location reads "Tolichowki only"; two or three are named; more are counted. Names come from the catalog, with a plain
 * fallback for a place this person's own limit does not show them.
 */
export function locationLimitLabel(locationIds: readonly string[] | undefined, nameOf: (id: string) => string): string | null {
  const ids = [...new Set(locationIds ?? [])];
  if (ids.length === 0) return null;
  const names = ids.map(nameOf);
  if (names.length === 1) return `${names[0]} only`;
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.length} locations`;
}

/** The ids to send: sorted and unique, so "nothing changed" is a plain comparison. */
export function normaliseLocationIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

export function sameLocationIds(a: readonly string[], b: readonly string[]): boolean {
  const left = normaliseLocationIds(a);
  const right = normaliseLocationIds(b);
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
