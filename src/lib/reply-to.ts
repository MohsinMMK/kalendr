import { z } from "zod";

/** The confirmation emails' reply address (feature 50). It is used only after a one-time code proved the owner can read it. */
export const replyToInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("send"), email: z.email().max(254) }),
  z.object({ action: z.literal("verify"), email: z.email().max(254), code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code.") }),
]);
export type ReplyToInput = z.infer<typeof replyToInput>;

export interface ReplyToView {
  /** The verified address replies go to, or null when none is set. */
  email: string | null;
  verifiedAt: string | null;
}
