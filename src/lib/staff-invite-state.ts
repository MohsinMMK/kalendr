/**
 * Where a team member stands with their invite, in words the team list can show. Pure, so the rules are tested without a
 * database. An invite is pending while the person has neither chosen a password nor signed in some other way (Google,
 * company sign-in, passkey, magic link).
 */

export function isInvitePending(person: { passwordSetAt: Date | string | null; lastSignInAt: Date | string | null }): boolean {
  return person.passwordSetAt === null && person.lastSignInAt === null;
}

export interface InviteExpiry {
  expired: boolean;
  /** "expires in 3 days", "expires in 5 hours", "expires within the hour" or "expired". */
  label: string;
}

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;

/** Null when no invite link is on record (it was never sent, or it was cancelled). */
export function inviteExpiry(expiresAt: Date | string | null, now: Date = new Date()): InviteExpiry | null {
  if (expiresAt === null) return null;
  const left = new Date(expiresAt).getTime() - now.getTime();
  if (left <= 0) return { expired: true, label: "expired" };
  if (left >= dayMs) {
    const days = Math.floor(left / dayMs);
    return { expired: false, label: `expires in ${days} ${days === 1 ? "day" : "days"}` };
  }
  if (left >= hourMs) {
    const hours = Math.floor(left / hourMs);
    return { expired: false, label: `expires in ${hours} ${hours === 1 ? "hour" : "hours"}` };
  }
  return { expired: false, label: "expires within the hour" };
}

/** "Signed in 3 days ago", "Signed in today", or "Never signed in". */
export function lastSignInLabel(lastSignInAt: Date | string | null, now: Date = new Date()): string {
  if (lastSignInAt === null) return "Never signed in";
  const ago = now.getTime() - new Date(lastSignInAt).getTime();
  if (ago < hourMs) return "Signed in just now";
  if (ago < dayMs) return "Signed in today";
  const days = Math.floor(ago / dayMs);
  if (days < 30) return `Signed in ${days} ${days === 1 ? "day" : "days"} ago`;
  const months = Math.floor(days / 30);
  return `Signed in ${months >= 12 ? "over a year" : `${months} ${months === 1 ? "month" : "months"}`} ago`;
}
