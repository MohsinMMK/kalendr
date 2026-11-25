import { formatMoney, priceFromLabel } from "@/lib/money";
import type { Service } from "@/lib/domain";
import type { LocationOptionKind, ServiceColor, ServiceLength, ServiceLocationOption } from "@/lib/service-setup";

import { getDurationLabel } from "./booking-format";

/**
 * What a customer can choose about one service: how long it takes and where it happens.
 * Services without the setup fields (preview data, older rows) have one length and meet in person,
 * so the extra screens never appear for them.
 */

/** The lengths on offer, shortest first. Always at least one, and exactly one is the default. */
export function serviceLengths(service: Pick<Service, "durationMinutes" | "priceLabel" | "lengths">): ServiceLength[] {
  const stored = service.lengths ?? [];
  if (stored.length === 0) {
    return [{ minutes: service.durationMinutes, priceMinor: priceFromLabel(service.priceLabel), isDefault: true }];
  }
  const sorted = stored.toSorted((a, b) => a.minutes - b.minutes);
  return sorted.some((length) => length.isDefault) ? sorted : sorted.map((length, index) => ({ ...length, isDefault: index === 0 }));
}

/** The length to book: the customer's choice when it is still offered, otherwise the usual one. */
export function chosenLength(service: Pick<Service, "durationMinutes" | "priceLabel" | "lengths">, minutes: number | undefined): ServiceLength {
  const lengths = serviceLengths(service);
  return lengths.find((length) => length.minutes === minutes) ?? lengths.find((length) => length.isDefault) ?? lengths[0]!;
}

/** "₹800", or nothing when the price varies. */
export function lengthPrice(length: ServiceLength, service: Pick<Service, "priceLabel">, onlyLength: boolean): string | undefined {
  if (length.priceMinor !== null) return formatMoney(length.priceMinor);
  return onlyLength ? service.priceLabel : undefined;
}

/** "45 min · ₹800", "30–60 min · from ₹500" when there are several lengths. */
export function serviceMeta(service: Pick<Service, "durationMinutes" | "priceLabel" | "lengths">): string {
  const lengths = serviceLengths(service);
  if (lengths.length === 1) {
    const only = lengths[0]!;
    return [getDurationLabel(only.minutes), lengthPrice(only, service, true)].filter(Boolean).join(" · ");
  }
  const first = lengths[0]!.minutes;
  const last = lengths[lengths.length - 1]!.minutes;
  const range = first === last ? getDurationLabel(first) : `${first}–${getDurationLabel(last)}`;
  const prices = lengths.flatMap((length) => (length.priceMinor === null ? [] : [length.priceMinor]));
  const lowest = prices.length > 0 ? Math.min(...prices) : undefined;
  const highest = prices.length > 0 ? Math.max(...prices) : undefined;
  const price = lowest === undefined ? undefined : lowest === highest ? formatMoney(lowest) : `from ${formatMoney(lowest)}`;
  return [range, price].filter(Boolean).join(" · ");
}

/** The ways to meet at the chosen branch. Phone and video options are offered everywhere. */
export function locationOptionsFor(service: Pick<Service, "locationOptions">, locationId: string): ServiceLocationOption[] {
  const stored = service.locationOptions ?? [];
  if (stored.length === 0) return [{ kind: "in_person", locationId: locationId || null, note: null }];
  const matching = stored.filter((option) => option.kind !== "in_person" || !locationId || option.locationId === locationId);
  return matching.length > 0 ? matching : [{ kind: "in_person", locationId: locationId || null, note: null }];
}

/** The customer is asked only when there is a real choice, or when the one option needs an answer. */
export function needsMeetStep(options: ServiceLocationOption[]): boolean {
  return options.length > 1 || options[0]?.kind === "their_address";
}

export function meetLabel(kind: LocationOptionKind): string {
  switch (kind) {
    case "in_person":
      return "Visit in person";
    case "we_call":
      return "We call you";
    case "they_call":
      return "You call us";
    case "video":
      return "Video call";
    case "their_address":
      return "At your address";
  }
}

/** One line saying what the choice means for the customer, before and after booking. */
export function meetDetail(kind: LocationOptionKind, branchName: string): string {
  switch (kind) {
    case "in_person":
      return `Come to ${branchName}.`;
    case "we_call":
      return "We call the number you give on the last screen.";
    case "they_call":
      return "You call us at the time you book. We show the number after you book.";
    case "video":
      return "We send you the video link before your time.";
    case "their_address":
      return "We come to you. Enter your address next.";
  }
}

/** Literal class names, so Tailwind's scanner can see them. */
const lightDot: Record<ServiceColor, string> = {
  blue: "bg-blue-500",
  violet: "bg-violet-500",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
};
const darkDot: Record<ServiceColor, string> = {
  blue: "dark:bg-blue-400",
  violet: "dark:bg-violet-400",
  emerald: "dark:bg-emerald-400",
  amber: "dark:bg-amber-400",
  rose: "dark:bg-rose-400",
};

/** Classes for a small colour dot, from the service's light and dark colours. Empty when none is set. */
export function serviceDotClass(service: Pick<Service, "colorLight" | "colorDark">): string {
  const light = service.colorLight ?? service.colorDark;
  const dark = service.colorDark ?? service.colorLight;
  return [light ? lightDot[light] : "", dark ? darkDot[dark] : ""].filter(Boolean).join(" ");
}

/** Everything the booking screens need to know about the chosen service's length and way of meeting. */
export function serviceChoices(
  service: Service | undefined,
  locationId: string,
  chosen: { minutes?: number; kind?: LocationOptionKind },
) {
  if (!service) {
    return { lengths: [] as ServiceLength[], length: undefined, meetOptions: [] as ServiceLocationOption[], meetAsked: false, meetKind: undefined, sendsLocationChoice: false };
  }
  const meetOptions = locationOptionsFor(service, locationId);
  return {
    lengths: serviceLengths(service),
    length: chosenLength(service, chosen.minutes),
    meetOptions,
    meetAsked: needsMeetStep(meetOptions),
    /** The way of meeting that applies: the customer's choice, or the only one on offer. */
    meetKind: meetOptions.length === 1 ? meetOptions[0]?.kind : meetOptions.find((option) => option.kind === chosen.kind)?.kind,
    /** Only services set up with options send a choice, so older services book exactly as before. */
    sendsLocationChoice: Boolean(service.locationOptions?.length),
  };
}
