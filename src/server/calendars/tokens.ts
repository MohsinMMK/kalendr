import type { OAuthCredentials, RefreshedTokens } from "./provider";

/**
 * Remembers tokens refreshed during this adapter's lifetime, so a worker job that makes
 * five calls with the same stored credentials refreshes once, not five times. The
 * persisted copy is still the consumer's job (via `onCredentialsRefreshed`).
 */
export class TokenMemory {
  private readonly latest = new Map<string, RefreshedTokens>();

  overlay(credentials: OAuthCredentials): OAuthCredentials {
    const known = this.latest.get(credentials.refreshToken);
    if (!known) return credentials;
    return { ...credentials, refreshToken: known.refreshToken, accessToken: known.accessToken, expiresAt: known.expiresAt };
  }

  remember(originalRefreshToken: string, tokens: RefreshedTokens): void {
    this.latest.set(originalRefreshToken, tokens);
    // A rotated refresh token must keep working as a key for callers still holding the old one.
    this.latest.set(tokens.refreshToken, tokens);
  }
}

export function accessTokenIsFresh(credentials: OAuthCredentials, now: Date, skewMs = 60_000): boolean {
  if (!credentials.accessToken || !credentials.expiresAt) return false;
  return Date.parse(credentials.expiresAt) - skewMs > now.getTime();
}
