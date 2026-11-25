import { z } from "zod";

/**
 * Own web address rules (feature 13), shared by the routes, the worker and the proxy. No database here.
 *
 * The owner adds two DNS records: a CNAME from the address to Kalendr, and a TXT record at `_kalendr-verify.<address>`
 * holding `kalendr-verify=<token>`. The TXT record sits on its own name because a name that has a CNAME cannot hold
 * any other record. Only the SHA-256 of the token is stored.
 */

export const verifyLabel = "_kalendr-verify";
export const verifyValuePrefix = "kalendr-verify=";
/** How long a new address keeps being rechecked, and how long a live address may have missing records before it stops being served. */
export const pendingWindowHours = 72;
export const missingGraceDays = 7;
export const maxEmbedOrigins = 20;

const labelPattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export interface HostnameRules {
  /** Hosts that are Kalendr's own (the app address and the CNAME target). An owner cannot claim these. */
  reservedHosts: readonly string[];
}

/** Normalises what an owner typed ("https://Book.Example.com/") to a lowercase hostname, or null when it is not one we can serve. */
export function normaliseHostname(input: string, rules: HostnameRules = { reservedHosts: [] }): string | null {
  let text = input.trim().toLowerCase();
  if (!text) return null;
  text = text.replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
  if (text.includes(":") || text.includes("@") || text.includes(" ")) return null;
  let host: string;
  try {
    // The URL parser turns an international name into its ASCII (punycode) form, which is what DNS and certificates use.
    host = new URL(`https://${text}`).hostname;
  } catch {
    return null;
  }
  if (host.length > 253) return null;
  const labels = host.split(".");
  // A subdomain is required: a CNAME cannot sit on a bare domain, and a bare domain would be the owner's whole website.
  if (labels.length < 3 || !labels.every((label) => labelPattern.test(label))) return null;
  if (/^[0-9.]+$/.test(host)) return null;
  const tld = labels.at(-1) ?? "";
  if (!/^[a-z]{2,}$/.test(tld) && !tld.startsWith("xn--")) return null;
  if (["localhost", "local", "internal", "test", "invalid", "example"].includes(tld)) return null;
  const reserved = rules.reservedHosts.map((entry) => entry.toLowerCase());
  if (reserved.some((entry) => host === entry || host.endsWith(`.${entry}`))) return null;
  return host;
}

export const hostnameInputSchema = z.object({ hostname: z.string().trim().min(3).max(260) });

export function verifyRecordName(hostname: string): string {
  return `${verifyLabel}.${hostname}`;
}

export function verifyRecordValue(token: string): string {
  return `${verifyValuePrefix}${token}`;
}

/** 256 random bits as hex. Shown to the owner once and stored only as a hash. */
export function newVerificationToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type DomainCheckResult = "ok" | "cname_missing" | "txt_missing" | "both_missing" | "lookup_failed";

export const checkResultText: Record<DomainCheckResult, string> = {
  ok: "Both records found.",
  cname_missing: "The CNAME record was not found yet.",
  txt_missing: "The TXT record was not found yet.",
  both_missing: "Neither record was found yet. DNS changes can take a while to spread.",
  lookup_failed: "The lookup did not finish. We will try again.",
};

/** A site allowed to frame the booking widget. https only, no path or credentials, and always the browser's own `origin` form. */
export function normaliseOrigin(input: string): string | null {
  const text = input.trim();
  if (!text || text.length > 253 || /[\s,;'"<>]/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const origin = url.origin;
  return /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/.test(origin) ? origin : null;
}

export const embedOriginInputSchema = z.object({ origin: z.string().trim().min(3).max(253) });

/** Words for the screen's four steps. */
export type DomainState = "pending" | "live" | "failed" | "warning";

export function domainState(domain: { status: string; missingSince: Date | null }): DomainState {
  if (domain.status === "active") return domain.missingSince ? "warning" : "live";
  return domain.status === "failed" ? "failed" : "pending";
}
