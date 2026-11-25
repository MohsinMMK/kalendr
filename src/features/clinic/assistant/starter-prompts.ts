import type { TermWords } from "@/lib/terminology";

/** The four questions the copilot offers on an empty chat. Plain words, in the business's own terms. */
export function starterPrompts(t: Pick<TermWords, "customers">): string[] {
  return [
    "Who is booked tomorrow?",
    "Find a free hour on Friday",
    `Which ${t.customers} haven't come back in 60 days?`,
    "Draft a reminder message",
  ];
}
