import { z } from "zod";

/** Shared by the staff screen, the routes and the booking commit (feature 45). */

export const specialLinkKinds = ["single_use", "limited", "expiring"] as const;
export type SpecialLinkKind = (typeof specialLinkKinds)[number];

export const MAX_LINK_USES = 1_000;

const idSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

/**
 * What staff choose when they make a link. `limited` may also carry an end time ("20 uses, until Friday"); a single use
 * may too. A link with neither a use count nor an end time would be a permanent public link, which the service already has.
 */
export const createSpecialLinkInput = z.object({
  label: z.string().trim().min(1, "Give the link a name you will recognise.").max(80),
  kind: z.enum(specialLinkKinds),
  maxUses: z.number().int().min(2).max(MAX_LINK_USES).optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
}).superRefine((value, context) => {
  if (value.kind === "limited" && value.maxUses === undefined) context.addIssue({ code: "custom", path: ["maxUses"], message: "Say how many times it can be used." });
  if (value.kind === "expiring" && value.expiresAt === undefined) context.addIssue({ code: "custom", path: ["expiresAt"], message: "Choose when it stops working." });
  if (value.kind !== "limited" && value.maxUses !== undefined) context.addIssue({ code: "custom", path: ["maxUses"], message: "Only a limited link takes a number of uses." });
  if (value.expiresAt !== undefined && Date.parse(value.expiresAt) <= Date.now()) context.addIssue({ code: "custom", path: ["expiresAt"], message: "Choose a time in the future." });
});
export type CreateSpecialLinkInput = z.infer<typeof createSpecialLinkInput>;

export const createCombinedLinkInput = z.object({
  label: z.string().trim().min(1, "Give the link a name you will recognise.").max(80),
  slug: z.string().trim().toLowerCase().min(2).max(60).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use letters, numbers and single dashes."),
  practitionerIds: z.array(idSchema).min(2, "Choose at least two people.").max(4, "Choose up to four people."),
});
export type CreateCombinedLinkInput = z.infer<typeof createCombinedLinkInput>;

export type SpecialLinkStatus = "active" | "used_up" | "expired" | "revoked";

export interface SpecialLinkView {
  id: string;
  label: string;
  kind: SpecialLinkKind;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  status: SpecialLinkStatus;
  bookings: { appointmentId: string; startsAt: string; status: string; customerName: string }[];
}

export interface CombinedLinkView {
  id: string;
  label: string;
  slug: string;
  practitionerIds: string[];
  createdAt: string;
}

/** Revoked beats expired beats used up: the reason staff read is the one that stopped it first. */
export function linkStatus(link: { maxUses: number | null; usedCount: number; expiresAt: Date | string | null; revokedAt: Date | string | null }, now: Date = new Date()): SpecialLinkStatus {
  if (link.revokedAt) return "revoked";
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= now.getTime()) return "expired";
  if (link.maxUses !== null && link.usedCount >= link.maxUses) return "used_up";
  return "active";
}

/** The path a customer opens. The token is shown to staff once, so it is never stored or logged. */
export const specialLinkPath = (token: string): string => `/l/${encodeURIComponent(token)}`;
