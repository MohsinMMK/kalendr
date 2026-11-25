"use client";

import type { FieldValues, Path, UseFormSetError } from "react-hook-form";

import { StatusBadge } from "@/components/status-badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { CreditEntryView, CustomerMembershipView, CustomerPackageView } from "@/lib/offers-contracts";

import { StaffApiError } from "./queries/http";
import { ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";

const dayFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", timeZone: "Asia/Kolkata" });
const dayLongYearFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
const dayYearFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const yearFormat = new Intl.DateTimeFormat("en-IN", { year: "numeric", timeZone: "Asia/Kolkata" });

/** "30 March", or "21 November 2027" when it isn't this year, so a year-long package never reads as ending today. */
export const offerDay = (iso: string, now: Date = new Date()) => {
  const day = new Date(iso);
  return (yearFormat.format(day) === yearFormat.format(now) ? dayFormat : dayLongYearFormat).format(day);
};
/** "30 Mar 2027". */
export const offerDayYear = (iso: string) => dayYearFormat.format(new Date(iso));

export function creditsLeftText(remaining: number, total: number): string {
  return `${remaining} of ${total} left`;
}

/** The status in words, never colour alone. */
export function PackageStatusBadge({ status }: { status: CustomerPackageView["status"] }) {
  if (status === "active") return <StatusBadge tone="success">Active</StatusBadge>;
  if (status === "used_up") return <StatusBadge tone="neutral">Used up</StatusBadge>;
  return <StatusBadge tone="danger">Expired</StatusBadge>;
}

/** What a membership is doing now. A failed renewal says when the benefits stop. */
export function membershipStatusText(membership: Pick<CustomerMembershipView, "status" | "benefitsOn" | "graceEndsAt">): { tone: "success" | "attention" | "neutral" | "danger"; text: string } {
  if (membership.status === "active") return { tone: "success", text: "Active" };
  if (membership.status === "past_due") {
    if (membership.benefitsOn && membership.graceEndsAt) return { tone: "attention", text: `Payment failed – benefits stop on ${offerDay(membership.graceEndsAt)}` };
    return { tone: "danger", text: "Payment failed – benefits are paused" };
  }
  if (membership.status === "paused") return { tone: "neutral", text: "Paused" };
  return { tone: "neutral", text: "Cancelled" };
}

export function MembershipStatusBadge({ membership }: { membership: Pick<CustomerMembershipView, "status" | "benefitsOn" | "graceEndsAt"> }) {
  const { tone, text } = membershipStatusText(membership);
  return <StatusBadge tone={tone} className="h-auto min-h-5.5 whitespace-normal text-start">{text}</StatusBadge>;
}

const ledgerTitles: Record<CreditEntryView["kind"], string> = {
  purchase: "Bought",
  renewal: "Added for the new month",
  grant: "Given",
  use: "Used",
  return: "Given back",
  expiry: "Expired",
  adjust: "Changed by hand",
};

/** One line of a package's history: what happened and why. */
export function ledgerLine(entry: CreditEntryView): { title: string; change: string } {
  const sign = entry.change > 0 ? "+" : entry.change < 0 ? "−" : "";
  return { title: ledgerTitles[entry.kind], change: `${sign}${Math.abs(entry.change)}` };
}

/** A checklist of services in a bordered list. Used for the services a package, plan or code covers. */
export function ServiceChecklist({ legend, services, value, onChange, hint, error }: {
  legend: string;
  services: { id: string; name: string }[];
  value: string[];
  onChange: (next: string[]) => void;
  hint?: string;
  error?: string;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 font-medium text-sm">{legend}</legend>
      {hint ? <p className="mb-1 text-muted-foreground text-xs">{hint}</p> : null}
      <ScrollAreaPrimitive.Root className="rounded-lg border"><ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className="max-h-56 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"><ScrollAreaPrimitive.Content style={{ minWidth: 0 }}><div className="flex flex-col">
        {services.map((service) => (
          <Label key={service.id} className="flex min-h-11 cursor-pointer items-center gap-3 border-b px-3 py-2 last:border-b-0 sm:min-h-10">
            <Checkbox checked={value.includes(service.id)} onCheckedChange={(checked) => onChange(checked === true ? [...value, service.id] : value.filter((id) => id !== service.id))} />
            <span className="min-w-0 flex-1 truncate">{service.name}</span>
          </Label>
        ))}
        {!services.length ? <p className="px-3 py-2 text-muted-foreground text-sm">No services yet.</p> : null}
      </div></ScrollAreaPrimitive.Content></ScrollAreaPrimitive.Viewport><ScrollBar orientation="vertical" /></ScrollAreaPrimitive.Root>
      {error ? <p role="alert" className="text-destructive-foreground text-xs">{error}</p> : null}
    </fieldset>
  );
}

/**
 * Puts the server's field messages beside the matching form fields. `map` goes from the server's field name to the form's.
 * Returns true when at least one message found a place.
 */
export function applyFieldErrors<T extends FieldValues>(cause: unknown, setError: UseFormSetError<T>, map: Record<string, Path<T>>): boolean {
  if (!(cause instanceof StaffApiError)) return false;
  let placed = false;
  for (const [serverField, formField] of Object.entries(map)) {
    const text = cause.fieldErrors[serverField]?.[0];
    if (text) {
      setError(formField, { type: "server", message: text });
      placed = true;
    }
  }
  return placed;
}

/** Plain digits for a whole-number text field, or null when it is not one. */
export function wholeNumber(value: string): number | null {
  const cleaned = value.trim();
  return /^\d{1,9}$/.test(cleaned) ? Number(cleaned) : null;
}
