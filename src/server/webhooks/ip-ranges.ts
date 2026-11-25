import { isIPv4, isIPv6 } from "node:net";

/**
 * Which addresses count as "the public internet" for webhook delivery (feature 34). Anything not clearly public is
 * refused, so an address that is private, loopback, link-local, shared (CGNAT), multicast, documentation or
 * otherwise reserved can never be reached through a webhook, including IPv6 forms that wrap an IPv4 address.
 */

function ipv4Parts(address: string): number[] | null {
  if (!isIPv4(address)) return null;
  return address.split(".").map(Number);
}

/** Expands an IPv6 address (with `::` and an optional trailing dotted IPv4) into eight 16-bit groups. */
export function ipv6Groups(address: string): number[] | null {
  const bare = address.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  if (!isIPv6(bare)) return null;
  let text = bare;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const parts = ipv4Parts(dotted[1]!);
    if (!parts) return null;
    text = text.slice(0, -dotted[1]!.length) + `${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = 8 - headGroups.length - tailGroups.length;
  if (tail === undefined ? headGroups.length !== 8 : missing < 0) return null;
  const all = tail === undefined ? headGroups : [...headGroups, ...Array<string>(missing).fill("0"), ...tailGroups];
  const numbers = all.map((group) => Number.parseInt(group, 16));
  return numbers.length === 8 && numbers.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffff) ? numbers : null;
}

function isPublicIpv4(parts: number[]): boolean {
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // shared address space (CGNAT)
  if (a === 169 && b === 254) return false; // link-local, including cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // protocol assignments, documentation
  if (a === 192 && b === 88 && c === 99) return false; // old 6to4 relay
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function isPublicIpv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  // IPv4-mapped (::ffff:a.b.c.d): judge the wrapped IPv4 address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPublicIpv4([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]);
  }
  // Only global unicast (2000::/3) can be public. That drops ::, ::1, fc00::/7, fe80::/10, ff00::/8, 64:ff9b::/96 and
  // every IPv4-compatible form in one rule.
  if ((g0 & 0xe000) !== 0x2000) return false;
  if (g0 === 0x2001 && g1 < 0x200) return false; // 2001::/23: protocol assignments, Teredo
  if (g0 === 0x2001 && g1 === 0xdb8) return false; // documentation
  if (g0 === 0x2002) return false; // 6to4 wraps an IPv4 address
  if (g0 === 0x3fff && g1 < 0x1000) return false; // documentation
  return true;
}

/** True only for an IPv4 or IPv6 address that is on the public internet. Text that is not an address is false. */
export function isPublicAddress(address: string): boolean {
  const v4 = ipv4Parts(address);
  if (v4) return isPublicIpv4(v4);
  const v6 = ipv6Groups(address);
  return v6 ? isPublicIpv6(v6) : false;
}

export function isIpLiteral(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  return isIPv4(bare) || isIPv6(bare);
}
