import { lookup } from "node:dns/promises";

import { isIpLiteral, isPublicAddress } from "./ip-ranges";

/**
 * Where a webhook may point (feature 34). Two checks, because a name can be fine today and resolve to a private
 * address tomorrow:
 *
 * 1. `validateWebhookUrl` runs when the address is saved. It looks only at the text (no lookup, because nothing in a
 *    web request calls out).
 * 2. `resolvePublicTarget` runs in the worker just before each delivery. It resolves the name, refuses if ANY answer
 *    is not public, and returns the address the connection must be pinned to, so the name can not change between the
 *    check and the connect.
 *
 * Ports: 443 and 8443 only. 443 is what nearly every receiver uses, and 8443 is the common alternate for services
 * that already hold 443. Fewer open ports means fewer internal services a mistaken or hostile address could hit.
 * There is no setting that loosens either check.
 */

export const WEBHOOK_URL_MAX_LENGTH = 2000;
export const WEBHOOK_ALLOWED_PORTS: readonly string[] = ["443", "8443"];

const blockedSuffixes = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan", ".intranet", ".corp"];

export type UrlCheck = { ok: true; url: string } | { ok: false; message: string };

const refuse = (message: string): UrlCheck => ({ ok: false, message });

export function validateWebhookUrl(input: string): UrlCheck {
  const text = input.trim();
  if (text.length === 0) return refuse("Enter the address that should receive events.");
  if (text.length > WEBHOOK_URL_MAX_LENGTH) return refuse(`The address can be at most ${WEBHOOK_URL_MAX_LENGTH} characters.`);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return refuse("Enter a full address that starts with https://.");
  }
  if (parsed.protocol !== "https:") return refuse("The address must start with https://. Plain http is not allowed.");
  if (parsed.username !== "" || parsed.password !== "") return refuse("Remove the user name and password from the address.");
  if (parsed.hash !== "") return refuse("Remove the # part from the address.");
  if (parsed.port !== "" && !WEBHOOK_ALLOWED_PORTS.includes(parsed.port)) {
    return refuse("The address can only use port 443 or 8443.");
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" ) return refuse("Enter a full address that starts with https://.");
  if (isIpLiteral(host)) {
    return isPublicAddress(host) ? { ok: true, url: parsed.toString() } : refuse("That address points to a private or internal network. Use a public address.");
  }
  if (host === "localhost" || blockedSuffixes.some((suffix) => host.endsWith(suffix)) || !host.includes(".")) {
    return refuse("That address points to a private or internal network. Use a public address.");
  }
  return { ok: true, url: parsed.toString() };
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Looks a name up and returns every answer. Tests pass a fake; the worker uses the system resolver. */
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: HostResolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.flatMap((answer) => (answer.family === 4 || answer.family === 6 ? [{ address: answer.address, family: answer.family }] : []));
};

export class BlockedAddressError extends Error {
  constructor() {
    super("Webhook target is not a public address");
    this.name = "BlockedAddressError";
  }
}

export class ResolveFailedError extends Error {
  constructor() {
    super("Webhook host did not resolve");
    this.name = "ResolveFailedError";
  }
}

/**
 * Resolves the host and returns the one address to connect to. Throws BlockedAddressError when any answer is not
 * public (a name with one public and one private answer is refused, so a rebinding trick can not slip through) and
 * ResolveFailedError when there is no answer.
 */
export async function resolvePublicTarget(hostname: string, resolver: HostResolver = systemResolver): Promise<ResolvedAddress> {
  const host = hostname.replace(/^\[|\]$/g, "");
  let answers: ResolvedAddress[];
  try {
    answers = isIpLiteral(host) ? [{ address: host, family: host.includes(":") ? 6 : 4 }] : await resolver(host);
  } catch {
    throw new ResolveFailedError();
  }
  const first = answers[0];
  if (!first) throw new ResolveFailedError();
  if (answers.some((answer) => !isPublicAddress(answer.address))) throw new BlockedAddressError();
  return first;
}
