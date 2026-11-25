/**
 * Pure rules of the platform admin console: where it may be reached from, how fresh a second factor must be, and what
 * "View as this business" may do. Kept free of server imports so each rule is tested on its own.
 */
import { ipVersion } from "@/lib/ip-address";
import type { Permission } from "@/lib/permissions";
import { impersonationCookieName, type PlatformRole } from "@/lib/admin-contracts";

/** A second-factor check older than this is asked for again, however recent the sign-in. */
export const adminSecondFactorMaxAgeHours = 12;

/** Length of "View as this business", in seconds (the database caps it at 30 minutes too). */
export const impersonationMaxAgeSeconds = 30 * 60;

export function adminSecondFactorIsFresh(at: Date | null, now: Date = new Date()): boolean {
  return at !== null && now.getTime() - at.getTime() <= adminSecondFactorMaxAgeHours * 3_600_000 && at.getTime() <= now.getTime() + 60_000;
}

/** Host header against KALENDR_ADMIN_HOST. Unset means any host; a port in the setting must match too. */
export function adminHostAllowed(hostHeader: string | null, configuredHost: string | undefined): boolean {
  if (!configuredHost) return true;
  const host = (hostHeader ?? "").trim().toLowerCase();
  if (configuredHost.includes(":")) return host === configuredHost;
  return host === configuredHost || host.replace(/:\d{1,5}$/, "") === configuredHost;
}

export function parseIpAllowlist(value: string | undefined): string[] {
  return (value ?? "").split(",").map((part) => normalizeIp(part.trim())).filter((part) => part !== "" && ipVersion(part) !== 0);
}

function normalizeIp(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
}

/**
 * The caller's address. With `trustedHops` proxies in front, the real client is that many entries from the right of
 * X-Forwarded-For (anything further left can be forged by the client). With none configured the last entry is used,
 * as the rate limiter does, and X-Real-IP is the fallback when there is no X-Forwarded-For at all.
 */
export function adminClientIp(headers: Headers, trustedHops: number): string | null {
  const entries = (headers.get("x-forwarded-for") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const chosen = entries.length > 0
    ? entries[trustedHops <= 0 ? entries.length - 1 : Math.max(0, entries.length - trustedHops)]
    : headers.get("x-real-ip")?.trim();
  if (!chosen) return null;
  const address = normalizeIp(chosen.replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, "$1"));
  return ipVersion(address) === 0 ? null : address;
}

/** With an allow-list, only listed addresses pass; an unknown address never does. */
export function adminIpAllowed(address: string | null, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  return address !== null && allowlist.includes(address);
}

/** What a role may do. Mirrors the checks inside the database functions, which stay the real gate. */
export const adminCapabilities = {
  readOverview: ["support", "billing", "super"],
  findMessages: ["support", "super"],
  operate: ["support", "super"],
  manageBilling: ["billing", "super"],
  impersonate: ["support", "super"],
  impersonateWrite: ["super"],
  manageRollouts: ["super"],
  manageOperators: ["super"],
} as const satisfies Record<string, readonly PlatformRole[]>;
export type AdminCapability = keyof typeof adminCapabilities;

export function roleCan(role: PlatformRole, capability: AdminCapability): boolean {
  return (adminCapabilities[capability] as readonly PlatformRole[]).includes(role);
}

/** Cookie flags for the impersonation token: the browser never lets a script read it and never sends it cross-site. */
export function impersonationCookie(token: string, production: boolean, maxAgeSeconds: number = impersonationMaxAgeSeconds): string {
  return [`${impersonationCookieName}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSeconds}`, ...(production ? ["Secure"] : [])].join("; ");
}

export function clearedImpersonationCookie(production: boolean): string {
  return impersonationCookie("", production, 0);
}

/** The only things an operator may do while viewing as a business without write access. */
export const readOnlyImpersonationPermissions: readonly Permission[] = ["records.view", "schedule.read", "audit.view", "reports.view", "reports.revenue"];

/** With write access, the full owner set minus what manages people or exposes secrets (design decision, see docs/platform-admin.md). */
export const writeImpersonationExcluded: readonly Permission[] = ["team.manage", "privacy.manage"];
