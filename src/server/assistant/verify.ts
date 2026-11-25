import "server-only";

import { sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { normalizeContact } from "@/lib/patient-contact";

import { ApiError } from "../api-error";
import { hitRateLimit, recordRefusal } from "../rate-limit";
import { rateLimitRules } from "../rate-limit-rules";
import { endPatientSession, patientSessionCookie, requestLoginCode, verifyLoginCode } from "../patient-auth";
import { markVerified, readOtpPhone, setOtpPhone } from "./store";
import type { ToolContext } from "./context";

/**
 * Proving a phone number on the web chat (feature 30). The code goes to the phone by text or WhatsApp, exactly like a portal
 * sign-in, and the customer types it into its own box, so the six digits never reach the model or the stored conversation.
 * Once it matches, the chat may see the bookings of the people with that number, and only those.
 *
 * WhatsApp and text chats skip this: the sender's number is already tied to a customer record by the thread it arrived on.
 */

/** Everyone in this business whose number is this one. Nothing is returned for a number nobody here uses. */
async function patientsWithPhone(tenantId: string, phone: string): Promise<string[]> {
  return withTenant(tenantId, async (transaction) => {
    const rows = await transaction.execute<{ id: string }>(sql`
      select id from patients where tenant_id = ${tenantId} and kalendr_normalize_phone(phone) = ${phone}
    `);
    return rows.map((row) => row.id);
  });
}

/** Sends a code when this business knows the number. The answer is the same either way, so it cannot be used to look numbers up. */
export async function sendVerificationCode(context: ToolContext, rawPhone: string): Promise<void> {
  const phone = normalizeContact("phone", rawPhone);
  if (!phone) throw new ApiError(400, "validation_error", "That doesn't look like a phone number.");
  const limited = await hitRateLimit("assistant.code", `chat:${context.conversation.id}`);
  const byPhone = await hitRateLimit("assistant.code", `phone:${phone}`);
  if (!limited.allowed || !byPhone.allowed) {
    recordRefusal("assistant.code");
    throw new ApiError(429, "rate_limited", rateLimitRules["assistant.code"].message);
  }
  const known = await patientsWithPhone(context.tenantId, phone);
  await withTenant(context.tenantId, (transaction) => setOtpPhone(transaction, context.tenantId, context.conversation.id, phone));
  if (known.length === 0) return;
  await requestLoginCode("phone", phone, { via: "text" });
}

export type CodeResult = { verified: true; patientIds: string[] } | { verified: false };

/** Checks the six digits the customer typed in the code box. */
export async function checkVerificationCode(tenantId: string, conversationId: string, code: string): Promise<CodeResult> {
  const phone = await withTenant(tenantId, (transaction) => readOtpPhone(transaction, tenantId, conversationId));
  if (!phone) return { verified: false };
  let grant;
  try {
    grant = await verifyLoginCode("phone", phone, code);
  } catch (error) {
    if (error instanceof ApiError && (error.code === "invalid_code" || error.code === "code_retry_later")) return { verified: false };
    throw error;
  }
  // The portal session this made is not wanted here: the chat only needed the proof.
  await endPatientSession(new Headers({ cookie: `${patientSessionCookie}=${grant.token}` }));
  const patientIds = await patientsWithPhone(tenantId, phone);
  if (patientIds.length === 0) return { verified: false };
  await withTenant(tenantId, (transaction) => markVerified(transaction, tenantId, conversationId, patientIds));
  return { verified: true, patientIds };
}
