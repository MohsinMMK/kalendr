import type { TermWords } from "@/lib/terminology";

import type { ImportJob, ImportKind, ImportStatus } from "./types";

export interface KindWords {
  /** Title case, for a choice: "Clients". */
  title: string;
  /** In a sentence: "clients". */
  noun: string;
  /** What this kind brings in, in one line. */
  summary: string;
}

/** What each kind is called for this business. A salon's customers are "clients", never "patients". */
export function kindWords(kind: ImportKind, t: TermWords): KindWords {
  switch (kind) {
    case "customers":
      return { title: t.Customers, noun: t.customers, summary: `Names, phone numbers and email addresses. ${t.Customers} you import get no text or WhatsApp consent unless your file says so and you confirm it.` };
    case "services":
      return { title: t.Services, noun: t.services, summary: `The ${t.services} you offer, with their length and price.` };
    case "appointments":
      return { title: `Future ${t.appointments}`, noun: t.appointments, summary: `${t.Appointments} that are already booked. Each one is matched to a ${t.customer}, ${t.service} and ${t.provider} you already have, and anything that would clash is listed, not saved.` };
  }
}

export const statusText: Record<ImportStatus, string> = {
  uploaded: "File uploaded",
  mapped: "Columns matched",
  checking: "Checking",
  checked: "Ready to import",
  queued: "Waiting to start",
  running: "Importing",
  done: "Finished",
  failed: "Stopped",
  undoing: "Undoing",
  undone: "Undone",
};

export type JobTone = "success" | "attention" | "neutral" | "danger" | "info";

export function statusTone(status: ImportStatus): JobTone {
  switch (status) {
    case "done": return "success";
    case "failed": return "danger";
    case "checking":
    case "queued":
    case "running":
    case "undoing": return "info";
    case "undone": return "neutral";
    default: return "attention";
  }
}

export const steps = ["upload", "map", "check", "import"] as const;
export type Step = (typeof steps)[number];

/** The step a job belongs on, from where the server says it is. */
export function stepFor(status: ImportStatus): Step {
  switch (status) {
    case "uploaded":
    case "mapped": return "map";
    case "checking":
    case "checked": return "check";
    default: return "import";
  }
}

/** Matching and checking can be redone only before anything is saved. */
export function canRedo(status: ImportStatus): boolean {
  return status === "uploaded" || status === "mapped" || status === "checked";
}

export function undoOpen(job: ImportJob, now: number): boolean {
  return job.status === "done" && job.undoUntil !== null && Date.parse(job.undoUntil) > now;
}

const dateOnly = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const dateTime = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
export const formatDay = (iso: string) => dateOnly.format(new Date(iso));
export const formatMoment = (iso: string) => dateTime.format(new Date(iso));

export const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
