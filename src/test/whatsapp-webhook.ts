import { signWhatsAppBody } from "@/server/channels/whatsapp-cloud";

/** An app secret for tests only. Never a real one. */
export const TEST_WHATSAPP_APP_SECRET = "kalendr-test-whatsapp-app-secret-0001";
export const TEST_WHATSAPP_VERIFY_TOKEN = "kalendr-test-whatsapp-verify-token-0001";

/** A body signed the way Meta signs it, with the headers to send it with. */
export function signedWhatsAppRequest(appSecret: string, body: unknown): { headers: Record<string, string>; body: string } {
  const raw = JSON.stringify(body);
  return { headers: { "content-type": "application/json", "x-hub-signature-256": signWhatsAppBody(appSecret, raw) }, body: raw };
}

/** What Meta posts when a customer sends text. */
export function inboundTextCallback(from: string, id: string, text: string, contextId?: string) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "waba-test", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      messages: [{ from: from.replace(/\D/g, ""), id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text }, ...(contextId ? { context: { id: contextId } } : {}) }],
    } }] }],
  };
}

/** A tap on a template's quick-reply button. */
export function buttonTapCallback(from: string, id: string, payload: string, label: string, contextId: string) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "waba-test", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      messages: [{ from: from.replace(/\D/g, ""), id, timestamp: String(Math.floor(Date.now() / 1000)), type: "button", button: { payload, text: label }, context: { id: contextId } }],
    } }] }],
  };
}

/** A delivery status for one of our messages. */
export function statusCallback(providerMessageId: string, status: "sent" | "delivered" | "read" | "failed", category = "utility") {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "waba-test", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      statuses: [{ id: providerMessageId, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: "0", pricing: { category }, ...(status === "failed" ? { errors: [{ code: 131026 }] } : {}) }],
    } }] }],
  };
}
