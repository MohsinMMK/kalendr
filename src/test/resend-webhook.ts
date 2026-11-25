import { Webhook } from "svix";

/** A webhook secret for tests only. Never a real one. */
export const TEST_WEBHOOK_SECRET = `whsec_${Buffer.from("kalendr-test-webhook-secret-0001").toString("base64")}`;

/** The headers Resend (through svix) would send with this body. */
export function signedHeaders(secret: string, id: string, body: string, at = new Date()): Headers {
  const signature = new Webhook(secret).sign(id, at, body);
  return new Headers({ "svix-id": id, "svix-timestamp": String(Math.floor(at.getTime() / 1000)), "svix-signature": signature });
}
