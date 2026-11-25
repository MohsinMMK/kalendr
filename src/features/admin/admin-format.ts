import type { PlatformRole } from "@/lib/admin-contracts";

/** What each operator role may do. The server decides again; this only hides what would be refused. */
export function adminCan(role: PlatformRole) {
  return {
    findMessages: role === "support" || role === "super",
    billing: role === "billing" || role === "super",
    pause: role === "support" || role === "super",
    resend: role === "support" || role === "super",
    viewAs: role === "support" || role === "super",
    viewAsWrite: role === "super",
    retry: role === "support" || role === "super",
    editRollouts: role === "super",
    manageOperators: role === "super",
  };
}

export const roleLabels: Record<PlatformRole, string> = { support: "Support", billing: "Billing", super: "Super admin" };

const dateTime = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const dateOnly = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
const timeOnly = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", second: "2-digit" });

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTime.format(new Date(iso)) : "Never";
}
export function formatDate(iso: string | null | undefined): string {
  return iso ? dateOnly.format(new Date(iso)) : "Never";
}
export function formatClock(date: Date): string {
  return timeOnly.format(date);
}

/** "3 minutes ago" without a library; support reads it at a glance. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "Never";
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  const days = Math.floor(seconds / 86_400);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  return `${Math.floor(seconds / 86_400)} d`;
}

const actionWords: Record<string, string> = {
  "tenant.paused": "Paused a business",
  "tenant.resumed": "Resumed a business",
  "tenant.verification_resent": "Resent a verification email",
  "impersonation.started": "Started viewing as a business",
  "impersonation.ended": "Ended viewing as a business",
  "outbox.retried": "Retried a failed message job",
  "feature.rollout_set": "Changed a feature rollout",
  "operator.saved": "Changed an operator",
};

/** `tenant.verification_resent` becomes "Resent a verification email"; unknown codes are spaced out, never hidden. */
export function humaniseAction(action: string): string {
  const known = actionWords[action];
  if (known) return known;
  const text = action.replace(/[._]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const setupStageLabels = { signed_up: "Signed up", services_added: "Services added", first_booking: "First booking" } as const;

export type Tone = "success" | "attention" | "neutral" | "danger" | "info";

export function messageTone(status: string): Tone {
  if (status === "delivered" || status === "read") return "success";
  if (status === "failed" || status === "dead_letter" || status === "bounced") return "danger";
  if (status === "sent") return "info";
  return "attention";
}

export function planLabel(key: string | null | undefined): string {
  return key ? key.charAt(0).toUpperCase() + key.slice(1).replace(/[_-]+/g, " ") : "";
}

/** A short form of an id for tables; the full id is in the page header. */
export function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}
