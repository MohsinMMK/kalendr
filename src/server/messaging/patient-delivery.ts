/**
 * Seals and opens what the worker needs to send a customer a code or a notice: the destination and the code. A sign-in
 * code belongs to no business, so the row id is the only thing that ties the sealed text to its place. No "server-only"
 * import: the worker opens these.
 */
import { openPrivate, sealPrivate } from "./sealed-link";

export const PATIENT_DELIVERY_PURPOSE = "patient_delivery";
/** Stands where a business id goes, because these rows have none. */
const PLATFORM = "platform";

export type PatientDeliveryPurpose = "sign_in" | "step_up" | "contact_changed";

export interface PatientDeliveryPayload {
  /** Digits as stored on the customer (any country format); the worker turns it into E.164. */
  phone?: string;
  email?: string;
  /** Six digits, for sign_in and step_up. */
  code?: string;
  /** The business name, for contact_changed. */
  business?: string;
}

export function sealDelivery(id: string, payload: PatientDeliveryPayload): string | null {
  return sealPrivate(PATIENT_DELIVERY_PURPOSE, PLATFORM, id, JSON.stringify(payload));
}

export function openDelivery(id: string, sealed: string | null): PatientDeliveryPayload | null {
  const text = openPrivate(PATIENT_DELIVERY_PURPOSE, PLATFORM, id, sealed);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const pick = (key: string) => (typeof parsed[key] === "string" ? (parsed[key] as string) : undefined);
    return { phone: pick("phone"), email: pick("email"), code: pick("code"), business: pick("business") };
  } catch {
    return null;
  }
}
