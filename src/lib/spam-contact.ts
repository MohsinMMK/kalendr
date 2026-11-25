import { z } from "zod";

import { normalizeContact } from "@/lib/patient-contact";

/**
 * How a contact is boiled down before it is compared with the blocklist (feature 44). Pure, so the booking path, the staff
 * screen and the tests all agree on one form.
 */

export const blocklistKinds = ["email", "phone", "email_domain"] as const;
export type BlocklistKind = (typeof blocklistKinds)[number];

/** Why staff reported a booking, or why an entry was added. Fixed codes: free text never reaches the audit trail. */
export const spamReasonCodes = ["fake_details", "abusive", "duplicate", "other"] as const;
export type SpamReasonCode = (typeof spamReasonCodes)[number];

export const spamReasonLabels: Record<SpamReasonCode, string> = {
  fake_details: "Fake details",
  abusive: "Abusive",
  duplicate: "Duplicate booking",
  other: "Something else",
};

export const reportDecisions = ["ignore", "block"] as const;

const gmailDomains = new Set(["gmail.com", "googlemail.com"]);

/** Splits an address at its last @ so the domain is never a guess. Null when it cannot be an address. */
function splitEmail(raw: string): { local: string; domain: string } | null {
  const email = normalizeContact("email", raw);
  if (!email) return null;
  const at = email.lastIndexOf("@");
  return { local: email.slice(0, at), domain: email.slice(at + 1) };
}

/** Lower-cased and trimmed; for Gmail the dots and the +tag are removed too, so `r.a.j+x@gmail.com` is `raj@gmail.com`. */
export function normalizeEmailForBlock(raw: string): string | null {
  const parts = splitEmail(raw);
  if (!parts) return null;
  if (!gmailDomains.has(parts.domain)) return `${parts.local}@${parts.domain}`;
  const local = (parts.local.split("+")[0] ?? "").replaceAll(".", "");
  return local ? `${local}@gmail.com` : null;
}

/** The part after the @, lower-cased. `googlemail.com` and `gmail.com` are the same provider. */
export function emailDomainOf(raw: string): string | null {
  const domain = splitEmail(raw)?.domain ?? null;
  return domain && gmailDomains.has(domain) ? "gmail.com" : domain;
}

/** A domain typed by staff: `@glow.example`, `Glow.Example` and a full address all give `glow.example`. */
export function normalizeDomainInput(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  const domain = trimmed.includes("@") ? trimmed.slice(trimmed.lastIndexOf("@") + 1) : trimmed;
  if (!/^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return null;
  return gmailDomains.has(domain) ? "gmail.com" : domain;
}

/** The canonical form of one blocklist value, or null when it is not a valid value of that kind. */
export function normalizeBlockValue(kind: BlocklistKind, raw: string): string | null {
  if (kind === "email") return normalizeEmailForBlock(raw);
  if (kind === "phone") return normalizeContact("phone", raw);
  return normalizeDomainInput(raw);
}

/** Every normal form a booking's contact can match: its address, its phone and its address's domain. */
export function contactKeys(contact: { email?: string | null; phone?: string | null }): { kind: BlocklistKind; value: string }[] {
  const keys: { kind: BlocklistKind; value: string }[] = [];
  const email = contact.email ? normalizeEmailForBlock(contact.email) : null;
  if (email) keys.push({ kind: "email", value: email });
  const domain = contact.email ? emailDomainOf(contact.email) : null;
  if (domain) keys.push({ kind: "email_domain", value: domain });
  const phone = contact.phone ? normalizeContact("phone", contact.phone) : null;
  if (phone) keys.push({ kind: "phone", value: phone });
  return keys;
}

/** A short form staff recognise but nobody can rebuild the value from: `r•••@gmail.com`, `•••• 4321`, `@glow.example`. */
export function blockHint(kind: BlocklistKind, normalized: string): string {
  if (kind === "email_domain") return `@${normalized}`;
  if (kind === "phone") return `•••• ${normalized.slice(-4)}`;
  const [local = "", domain = ""] = normalized.split("@");
  return `${local.slice(0, 1)}•••@${domain}`;
}

export const blocklistEntryInput = z.object({
  kind: z.enum(blocklistKinds),
  value: z.string().trim().min(3).max(254),
  reasonCode: z.enum(spamReasonCodes).default("other"),
});
export type BlocklistEntryInput = z.infer<typeof blocklistEntryInput>;

export const reportBookingInput = z.object({
  expectedVersion: z.number().int().positive(),
  reasonCode: z.enum(spamReasonCodes),
});

export const decideReportInput = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("ignore") }),
  z.object({ decision: z.literal("block"), kind: z.enum(blocklistKinds) }),
]);
export type DecideReportInput = z.infer<typeof decideReportInput>;

export interface BlocklistEntryView {
  id: string;
  kind: BlocklistKind;
  hint: string;
  reasonCode: SpamReasonCode;
  addedByName: string | null;
  createdAt: string;
}

export interface BookingReportView {
  id: string;
  appointmentId: string;
  reasonCode: SpamReasonCode;
  status: "open" | "ignored" | "blocked";
  reportedByName: string | null;
  createdAt: string;
  decidedAt: string | null;
  /** The masked contact the report is about. */
  emailHint: string | null;
  phoneHint: string | null;
  /** How many bookings this contact has made here, and when the reported one was for. */
  bookingCount: number;
  startsAt: string;
}
