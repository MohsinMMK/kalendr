"use client";

import { Badge } from "@/components/ui/badge";
import type { InvoicePayState } from "@/lib/invoicing-contracts";

export const payStateLabels: Record<InvoicePayState, string> = {
  unpaid: "Unpaid",
  part_paid: "Part paid",
  paid: "Paid",
  credited: "Credited",
  refund_due: "Refund due",
};
const payStateVariants: Record<InvoicePayState, "success" | "warning" | "info" | "outline" | "error"> = {
  unpaid: "warning",
  part_paid: "warning",
  paid: "success",
  credited: "info",
  refund_due: "error",
};

/** The state in words; the colour only backs them up. */
export function InvoiceStateBadge({ state }: { state: InvoicePayState }) {
  return <Badge variant={payStateVariants[state]}>{payStateLabels[state]}</Badge>;
}

export function invoiceDate(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(iso));
}

export function monthLabel(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year!, number! - 1, 1)));
}

/** "YYYY-MM" for today, in the business's calendar. */
export function currentMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", timeZone: "Asia/Kolkata" }).formatToParts(now);
  return `${parts.find((part) => part.type === "year")!.value}-${parts.find((part) => part.type === "month")!.value}`;
}

/** The last `count` months, newest first. */
export function recentMonths(count: number, now = new Date()): string[] {
  const [year, month] = currentMonth(now).split("-").map(Number);
  return Array.from({ length: count }, (_, index) => {
    const moment = new Date(Date.UTC(year!, month! - 1 - index, 1));
    return `${moment.getUTCFullYear()}-${String(moment.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

/** Gives the browser a file it has fetched. The CSV routes answer with a file, not JSON, so they cannot use staffQuery. */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? "The file could not be made. Try again.");
  }
  const blob = await response.blob();
  const name = /filename="?([^";]+)"?/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
