import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { ACCESS_TOKEN_PREFIX, CLIENT_SECRET_PREFIX, CODE_PREFIX, DEVICE_CODE_PREFIX, REFRESH_TOKEN_PREFIX } from "@/lib/oauth";

/** 256 random bits behind a readable prefix, so a leaked value can be recognised and reported. Only hashes are stored. */
export type TokenKind = "access" | "refresh" | "code" | "secret" | "device";

const prefixes: Record<TokenKind, string> = {
  access: ACCESS_TOKEN_PREFIX,
  refresh: REFRESH_TOKEN_PREFIX,
  code: CODE_PREFIX,
  secret: CLIENT_SECRET_PREFIX,
  device: DEVICE_CODE_PREFIX,
};

export function newToken(kind: TokenKind): string {
  return `${prefixes[kind]}${randomBytes(32).toString("base64url")}`;
}

export function hashToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A well-formed access token, checked before any lookup so junk costs nothing. */
export const accessTokenPattern = /^kat_[A-Za-z0-9_-]{43}$/;

/** PKCE S256: the challenge is the unpadded base64url of the SHA-256 of the verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
