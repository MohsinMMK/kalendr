import "server-only";

import { randomBytes } from "node:crypto";

/**
 * A browser's own id, for the per-device code limit (feature 8). It is a random value in a cookie, not a fingerprint:
 * it says "this browser asked", nothing more, and it holds no contact or account. A script that drops the cookie is
 * still held by the per-network and per-contact limits.
 */
export const patientDeviceCookie = process.env.NODE_ENV === "production" ? "__Host-kalendr_device" : "kalendr_device";

const idPattern = /^[A-Za-z0-9_-]{22,64}$/;

export function deviceIdFrom(headers: Headers): string | null {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === patientDeviceCookie) {
      const value = part.slice(separator + 1).trim();
      return idPattern.test(value) ? value : null;
    }
  }
  return null;
}

export function newDeviceId(): string {
  return randomBytes(16).toString("base64url");
}

export function deviceCookieHeader(id: string): string {
  return `${patientDeviceCookie}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 24 * 60 * 60}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
