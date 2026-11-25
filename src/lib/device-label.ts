/**
 * A short, human description of a browser from its user agent, such as "Chrome on macOS".
 * Deliberately coarse: it names the browser family and the system, nothing finer, so it
 * is safe to show and to put in an email.
 */
export function deviceLabel(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\/|Opera/.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : "Browser";
  const system = /Android/.test(userAgent)
    ? "Android"
    : /iPhone|iPad|iPod/.test(userAgent)
      ? "iOS"
      : /Mac OS X|Macintosh/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux|X11/.test(userAgent)
            ? "Linux"
            : null;
  return system ? `${browser} on ${system}` : browser;
}

/** The first three parts of an IPv4 address (or the first four groups of IPv6), so a device list shows a rough network and not an exact address. */
export function maskedAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  if (address === "::1" || address === "127.0.0.1") return "This computer";
  if (address.includes(":")) return `${address.split(":").slice(0, 4).join(":")}::`;
  const parts = address.split(".");
  return parts.length === 4 ? `${parts.slice(0, 3).join(".")}.•` : null;
}
