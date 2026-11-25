import { defaultBusinessProfile, profileWords, type TermWords } from "@/lib/terminology";

export interface TimingMove {
  appointmentId: string;
  from: string;
  to: string;
}

export interface TimingResult {
  moved: TimingMove[];
  /** Visits with no free time left with this doctor. A person has to decide what happens to them. */
  unresolved: string[];
}

/** The opening closest to the original time. On a tie the later one wins, so nobody is asked to come early. */
export function pickNearestSlot<Slot extends { startsAt: string }>(originalIso: string, slots: readonly Slot[]): Slot | null {
  const original = Date.parse(originalIso);
  let best: Slot | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const slot of slots) {
    const start = Date.parse(slot.startsAt);
    const distance = Math.abs(start - original);
    if (distance < bestDistance || (distance === bestDistance && best && start > Date.parse(best.startsAt))) {
      best = slot;
      bestDistance = distance;
    }
  }
  return best;
}

/** Leaving `words` out keeps the healthcare wording. */
export function timingSummary(
  result: TimingResult,
  words: Pick<TermWords, "customer"> = profileWords(defaultBusinessProfile),
): string {
  const moved = result.moved.length;
  const stuck = result.unresolved.length;
  if (!moved && !stuck) return "No bookings were affected.";
  const parts = [];
  if (moved) parts.push(`${moved} booking${moved === 1 ? "" : "s"} moved, ${words.customer} update${moved === 1 ? "" : "s"} queued`);
  if (stuck) parts.push(`${stuck} need${stuck === 1 ? "s" : ""} a person in Messages`);
  return `${parts.join(". ")}.`;
}
