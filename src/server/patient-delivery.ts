import "server-only";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { getDatabase } from "@/db/client";

import { ApiError } from "./api-error";
import { sealDelivery, type PatientDeliveryPayload, type PatientDeliveryPurpose } from "./messaging/patient-delivery";

/**
 * Hands a code or notice to the worker. The request never talks to WhatsApp, a text provider or email: it seals the
 * destination and code into a platform row (no business id, reachable only through definer functions) and the worker
 * sends it, WhatsApp first, then text, then email, and clears the sealed copy.
 */
export async function queuePatientDelivery(input: {
  purpose: PatientDeliveryPurpose;
  payload: PatientDeliveryPayload;
  /** "text" skips WhatsApp. */
  via?: "auto" | "text";
  /** After this the worker drops it unsent. */
  lifetimeMs: number;
}): Promise<string> {
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "Sign-in is unavailable.");
  const id = randomUUID();
  const sealed = sealDelivery(id, input.payload);
  // In production with no records key nothing can be sealed, so nothing is sent: say so instead of pretending.
  if (!sealed) throw new ApiError(503, "code_delivery_unavailable", "We couldn't send the code. Try again shortly.");
  await database.execute(sql`select kalendr_queue_code_delivery(${id}, ${input.purpose}, ${input.via ?? "auto"}, ${sealed}, ${new Date(Date.now() + input.lifetimeMs).toISOString()}::timestamptz)`);
  return id;
}
