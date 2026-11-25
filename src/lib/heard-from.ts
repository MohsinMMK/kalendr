import type { Appointment } from "@/lib/domain";

/** How a customer found the business, asked once on the confirmation. */
export const heardFromValues = ["search", "social", "friend", "referral", "walk_by", "other"] as const;
export type HeardFrom = (typeof heardFromValues)[number];

export function isHeardFrom(value: unknown): value is HeardFrom {
  return typeof value === "string" && (heardFromValues as readonly string[]).includes(value);
}

/** The customer's answer choices, in the business's words. */
export function heardFromOptions(words: { clinical: boolean }): { value: HeardFrom; label: string }[] {
  return [
    { value: "search", label: "Google or another search" },
    { value: "social", label: "Social media" },
    { value: "friend", label: "A friend or family member" },
    { value: "referral", label: words.clinical ? "Referred by a doctor" : "Referred by someone else" },
    { value: "walk_by", label: "Walked or drove past" },
    { value: "other", label: "Somewhere else" },
  ];
}

/** Short labels for staff screens. */
export const heardFromLabels: Record<HeardFrom, string> = {
  search: "Search",
  social: "Social media",
  friend: "Friend or family",
  referral: "Referral",
  walk_by: "Walked past",
  other: "Other",
};

export const HEARD_FROM_WINDOW_DAYS = 90;

/** Answers from bookings in the last 90 days (and upcoming ones), most common first. */
export function summarizeHeardFrom(
  appointments: readonly Pick<Appointment, "startsAt" | "heardFrom">[],
  now: Date = new Date(),
): { total: number; rows: { value: HeardFrom; label: string; count: number; share: number }[] } {
  const since = now.getTime() - HEARD_FROM_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const counts = new Map<HeardFrom, number>();
  for (const appointment of appointments) {
    if (!appointment.heardFrom || Date.parse(appointment.startsAt) < since) continue;
    counts.set(appointment.heardFrom, (counts.get(appointment.heardFrom) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const rows = heardFromValues
    .filter((value) => counts.has(value))
    .map((value) => {
      const count = counts.get(value) ?? 0;
      return { value, label: heardFromLabels[value], count, share: total ? count / total : 0 };
    })
    .sort((a, b) => b.count - a.count);
  return { total, rows };
}
