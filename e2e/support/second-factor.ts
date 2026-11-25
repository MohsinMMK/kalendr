import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Authenticator-app codes for the browser journeys (RFC 6238: SHA-1, 6 digits, 30 seconds, the
 * same as Better Auth's plugin). The secrets the journeys enrol are kept in .e2e so a later
 * sign-in as the same person can answer the code step.
 */
const base32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeBase32(value: string): Buffer {
  let bits = "";
  for (const character of value.replace(/=+$/, "").toUpperCase()) {
    const index = base32.indexOf(character);
    if (index < 0) throw new Error("Not a base32 secret.");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret: string, at: number = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(value % 1_000_000).padStart(6, "0");
}

/** A code that stays valid long enough to type: waits out the last two seconds of a 30-second step. */
export async function freshCode(secret: string): Promise<string> {
  const remaining = 30_000 - (Date.now() % 30_000);
  if (remaining < 2_500) await new Promise((done) => setTimeout(done, remaining + 100));
  return totp(secret);
}

const secretsFile = resolve(process.cwd(), process.env.KALENDR_E2E_STATE_DIR ?? ".e2e", "second-factors.json");

export function rememberSecret(email: string, secret: string): void {
  const known = existsSync(secretsFile) ? (JSON.parse(readFileSync(secretsFile, "utf8")) as Record<string, string>) : {};
  known[email] = secret;
  mkdirSync(dirname(secretsFile), { recursive: true });
  writeFileSync(secretsFile, JSON.stringify(known), { mode: 0o600 });
}

export function recallSecret(email: string): string | undefined {
  if (!existsSync(secretsFile)) return undefined;
  return (JSON.parse(readFileSync(secretsFile, "utf8")) as Record<string, string>)[email];
}
