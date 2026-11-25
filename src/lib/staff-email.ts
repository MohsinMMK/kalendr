import { z } from "zod";

/**
 * Changing a staff sign-in email. Two ways in: a person changes their own (Better Auth's change-email, confirmed by a link sent
 * to the new address), or an owner or admin changes a teammate's. Both screens and both servers share these shapes.
 */

/** One sign-in email: trimmed, lower-cased, a real address. */
export const staffEmailSchema = z.string().trim().toLowerCase().pipe(z.email("Enter a full email address, like name@example.com.").max(254, "That email is too long."));

export const staffOwnEmailChangeSchema = z.object({ newEmail: staffEmailSchema }).strict();
export const staffMemberEmailChangeSchema = z.object({ newEmail: staffEmailSchema }).strict();

export type StaffOwnEmailChangeInput = z.infer<typeof staffOwnEmailChangeSchema>;
export type StaffMemberEmailChangeInput = z.infer<typeof staffMemberEmailChangeSchema>;

/** What the screens get back after an admin changes a teammate's email. No address in it: the caller already knows what they typed. */
export interface StaffMemberEmailChangeResult {
  membershipId: string;
  /** True when the teammate had not accepted their invite, so a new invite went to the new address. */
  inviteReissued: boolean;
  /** The new invite link, shown once so it can be shared another way. Only set when `inviteReissued`. */
  invite?: { url: string; emailed: boolean; expiresAt: string };
}

/**
 * The notice emails about a changed sign-in address, sent by the worker (outbox event `account.email_notice`).
 * - `requested`: to the OLD address when someone asks to change it, before anything has changed.
 * - `changed`: to the OLD address once it has changed, by the person themselves.
 * - `changed_by_admin`: to the OLD address when an owner or admin changed it.
 * - `now_yours`: to the NEW address when an owner or admin set it.
 * - `added_to_business`: no longer queued. A business now invites an existing login (`staff-login-invites.ts`) and the person
 *   accepts after signing in; the kind stays so notices already waiting in the outbox still send.
 */
export const ACCOUNT_EMAIL_NOTICE_EVENT = "account.email_notice";
export const ACCOUNT_EMAIL_NOTICE_PURPOSE = "account_email_notice";
export const accountEmailNoticeKinds = ["requested", "changed", "changed_by_admin", "now_yours", "added_to_business"] as const;
export type AccountEmailNoticeKind = (typeof accountEmailNoticeKinds)[number];

/**
 * The outbox payload. The address it goes to is not in it: it travels sealed (AES-GCM, tied to the business and to this row),
 * the way the booking page's email codes do, so the outbox table never holds a readable address.
 */
export const accountEmailNoticePayloadSchema = z.object({
  kind: z.enum(accountEmailNoticeKinds),
  sealed: z.string().min(1).max(2000),
});
export type AccountEmailNoticePayload = z.infer<typeof accountEmailNoticePayloadSchema>;

/** What is sealed: where to send it and the first name to greet. Never the other address. */
export const accountEmailNoticeSecretSchema = z.object({
  email: z.string().min(3).max(254),
  name: z.string().max(160),
  /** The business, so the notice can say who to ask. */
  business: z.string().max(160),
  /** When it happened, as text in the business's own words (a date and time). */
  when: z.string().max(80),
});
export type AccountEmailNoticeSecret = z.infer<typeof accountEmailNoticeSecretSchema>;

/** Audit actions this feature writes. Metadata never holds an address. */
export const emailAuditActions = {
  memberChanged: "staff.member.email_changed",
  ownRequested: "staff.email.change_requested",
  ownChanged: "staff.email.changed",
} as const;
