import { createHmac, timingSafeEqual } from "node:crypto";

/** Constant-time comparison of two hex or text signatures of any length. */
export function sameSignature(expected: string, received: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}
