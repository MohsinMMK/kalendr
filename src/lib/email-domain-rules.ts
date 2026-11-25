import { createHash } from "node:crypto";

/**
 * Company email domains (feature 53). The owner publishes one TXT record; the worker looks for it. Only the SHA-256 hash of
 * the token is stored, so a copy of the database cannot be used to claim someone's domain.
 */

export const emailDomainRecordPrefix = "_kalendr-verify";
export const emailDomainValuePrefix = "kalendr-verify=";
/** A domain that has not been proved after this long stops being checked. The owner can ask for a new record. */
export const emailDomainCheckDays = 7;

export function emailDomainRecordName(domain: string): string {
  return `${emailDomainRecordPrefix}.${domain}`;
}

export function emailDomainRecordValue(token: string): string {
  return `${emailDomainValuePrefix}${token}`;
}

export function hashDomainToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type EmailDomainJudgement = { kind: "verified" } | { kind: "missing"; note: string } | { kind: "lookup_failed"; note: string };

/** Judges the TXT values found at the record name. `txt` is null when the lookup itself failed (an outage is not a "no"). */
export function judgeEmailDomain(txt: readonly string[] | null, tokenHash: string): EmailDomainJudgement {
  if (txt === null) return { kind: "lookup_failed", note: "We couldn't reach your DNS just now. We'll try again." };
  for (const value of txt) {
    const trimmed = value.trim();
    if (!trimmed.startsWith(emailDomainValuePrefix)) continue;
    if (hashDomainToken(trimmed.slice(emailDomainValuePrefix.length)) === tokenHash) return { kind: "verified" };
  }
  return txt.some((value) => value.trim().startsWith(emailDomainValuePrefix))
    ? { kind: "missing", note: "We found a Kalendr record, but it isn't the one for this business. Copy the value again." }
    : { kind: "missing", note: "We can't see the record yet. DNS changes can take up to an hour." };
}

/** The part after the last "@", lower-cased, or null when the address has none. */
export function emailDomainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}
