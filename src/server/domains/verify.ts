/**
 * The pure half of address verification (feature 13): hashing the token and judging what DNS returned. No
 * "server-only": the worker imports this. Lives apart from src/lib/domain-rules.ts because it needs node:crypto.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { verifyValuePrefix, type DomainCheckResult } from "@/lib/domain-rules";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** True when any TXT value is `kalendr-verify=<token>` for the stored hash. Compares hashes in constant time. */
export function txtMatchesHash(values: readonly string[], storedHash: string | null): boolean {
  if (!storedHash || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const expected = Buffer.from(storedHash, "hex");
  return values.some((value) => {
    const trimmed = value.trim();
    if (!trimmed.startsWith(verifyValuePrefix)) return false;
    const actual = Buffer.from(hashToken(trimmed.slice(verifyValuePrefix.length).trim()), "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

const stripDot = (value: string): string => value.trim().toLowerCase().replace(/\.$/, "");

/** True when any CNAME answer is the Kalendr target (a trailing dot and letter case do not matter). */
export function cnameMatches(answers: readonly string[], target: string): boolean {
  const wanted = stripDot(target);
  return wanted !== "" && answers.some((answer) => stripDot(answer) === wanted);
}

export interface DnsAnswers {
  /** null when the lookup itself failed (timeout, server error), which is different from "no such record". */
  cname: string[] | null;
  txt: string[] | null;
}

/** What a pair of lookups means. A failed lookup is never read as a missing record, so a DNS outage cannot switch an address off. */
export function judgeDomain(answers: DnsAnswers, target: string, tokenHash: string | null): DomainCheckResult {
  if (answers.cname === null || answers.txt === null) return "lookup_failed";
  const cname = cnameMatches(answers.cname, target);
  const txt = txtMatchesHash(answers.txt, tokenHash);
  if (cname && txt) return "ok";
  if (!cname && !txt) return "both_missing";
  return cname ? "txt_missing" : "cname_missing";
}

