import { createHash, randomBytes } from "node:crypto";

/** The private calendar feed address carries a 256-bit token; only its SHA-256 is stored, like manage links. */
export function newFeedToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: feedTokenHash(token) };
}

export function feedTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A token as the route accepts it: 43 URL-safe characters. Anything else is refused before the database is asked. */
export function isFeedToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}
