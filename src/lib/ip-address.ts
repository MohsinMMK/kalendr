/**
 * Whether a string is an IPv4 or IPv6 address, without `node:net` so it can be bundled for any runtime (Next.js also
 * compiles `instrumentation.ts` for the edge, where `node:` imports are not handled). Same answers as `net.isIP`:
 * returns 4, 6 or 0. IPv4 is four decimal parts of 0-255 with no leading zeros; IPv6 allows one `::`, an embedded
 * IPv4 tail, and a `%zone` suffix.
 */
export function ipVersion(value: string): 0 | 4 | 6 {
  if (isIPv4(value)) return 4;
  return isIPv6(value) ? 6 : 0;
}

function isIPv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function isIPv6(input: string): boolean {
  const zoneAt = input.indexOf("%");
  const value = zoneAt === -1 ? input : input.slice(0, zoneAt);
  if (zoneAt !== -1 && zoneAt === input.length - 1) return false;
  if (!value.includes(":") || /[^0-9a-fA-F:.]/.test(value)) return false;
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const groups = (text: string): string[] | null => (text === "" ? [] : text.split(":"));
  const head = groups(halves[0] ?? "");
  const tail = halves.length === 2 ? groups(halves[1] ?? "") : [];
  if (!head || !tail) return false;
  const all = [...head, ...tail];
  let width = 0;
  for (let index = 0; index < all.length; index += 1) {
    const group = all[index] as string;
    const last = index === all.length - 1;
    if (last && group.includes(".")) {
      if (!isIPv4(group)) return false;
      width += 2;
    } else if (/^[0-9a-fA-F]{1,4}$/.test(group)) width += 1;
    else return false;
  }
  return halves.length === 2 ? width < 8 : width === 8;
}
