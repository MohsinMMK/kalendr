import { limitSentence } from "./limits";
import type { SlotEngineInput } from "./types";

/** Plain sentences for the reasons a start can be refused, for the person who tried to book it. */

function noticeSentence(minutes: number): string {
  if (minutes >= 2880 && minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes >= 120 && minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

export function slotRejection(reason: string, input: SlotEngineInput): string | undefined {
  switch (reason) {
    case "within_minimum_notice":
      return `That time is too soon. Please book at least ${noticeSentence(input.service.minimumNoticeMinutes)} ahead.`;
    case "beyond_booking_window":
      return "That time is further ahead than bookings are open. Please choose an earlier date.";
    case "walk_in_timeframe":
      return "A walk-in must start now. Choose one of the openings for the next few hours.";
    case "daily_limit_reached":
    case "period_limit_reached":
      return limitSentence(reason);
    default:
      return undefined;
  }
}
