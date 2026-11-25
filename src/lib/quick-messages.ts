import type { TermWords } from "./terminology";

/**
 * Short, fixed messages the front desk sends from Today. They are fixed wording, not free text,
 * so they can later become approved WhatsApp and SMS templates without changing what staff see.
 */
/** "almost_next" is not sent by staff: the customer asks for it from their queue link. */
export const quickMessageKinds = ["your_turn", "running_late", "call_us", "almost_next"] as const;

export type QuickMessageKind = (typeof quickMessageKinds)[number];

export const QUICK_MESSAGE_EVENT = "appointment.quick_message";

/** How late the business can say it is running, in minutes. */
export const delayOptions = [10, 15, 20, 30, 45, 60, 90] as const;

export const MIN_DELAY_MINUTES = 5;
export const MAX_DELAY_MINUTES = 180;

type Words = Pick<TermWords, "appointment">;

/** What staff see in menus and on the Messages page. */
export function quickMessageLabel(kind: QuickMessageKind): string {
  return { your_turn: "It's your turn", running_late: "Running late", call_us: "Please call us", almost_next: "You're almost next" }[kind];
}

/** The text the customer gets. The business name is added in front by the sender. */
export function quickMessageBody(
  kind: QuickMessageKind,
  words: Words,
  details: { delayMinutes?: number; queueNumber?: number; startsAt?: string },
): string {
  switch (kind) {
    case "your_turn":
      return details.queueNumber
        ? `Token ${details.queueNumber}, it's your turn. Please come to the front desk.`
        : "It's your turn. Please come to the front desk.";
    case "running_late":
      return `We're running about ${details.delayMinutes ?? MIN_DELAY_MINUTES} minutes late. Sorry for the wait. Your ${words.appointment}${details.startsAt ? ` at ${details.startsAt}` : ""} is still on.`;
    case "almost_next":
      return details.queueNumber
        ? `Token ${details.queueNumber}, you're almost next. Please stay close to the front desk.`
        : "You're almost next. Please stay close to the front desk.";
    case "call_us":
      return `Please call us about your ${words.appointment}${details.startsAt ? ` at ${details.startsAt}` : ""}.`;
  }
}
