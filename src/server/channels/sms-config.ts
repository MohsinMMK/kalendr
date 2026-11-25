/**
 * Builds the SMS channel from the environment. Returns null when SMS is not set up, and when
 * localOnly (the local capture worker) refuses any provider URL that is not on this machine,
 * so a local run can never text a real phone.
 */
import { appOrigin, env, isLoopbackUrl, type EnvironmentSource } from "../env";
import { createMsg91Channel, MSG91_FLOW_URL } from "./sms-msg91";
import { createTwilioChannel } from "./sms-twilio";
import type { Channel } from "./types";

export function smsChannelFromEnv(options: { localOnly: boolean }, source: EnvironmentSource = process.env): Channel | null {
  const value = env(source);
  if (value.SMS_PROVIDER === "msg91") {
    if (!value.MSG91_AUTH_KEY || !value.MSG91_SENDER_ID) return null;
    if (options.localOnly && !isLoopbackUrl(value.MSG91_API_URL)) return null;
    return createMsg91Channel({
      authKey: value.MSG91_AUTH_KEY,
      senderId: value.MSG91_SENDER_ID,
      apiUrl: value.MSG91_API_URL ?? MSG91_FLOW_URL,
    });
  }
  if (value.SMS_PROVIDER === "twilio") {
    if (!value.TWILIO_ACCOUNT_SID || !value.TWILIO_AUTH_TOKEN || !value.TWILIO_FROM) return null;
    if (options.localOnly && !isLoopbackUrl(value.TWILIO_API_URL)) return null;
    return createTwilioChannel({
      accountSid: value.TWILIO_ACCOUNT_SID,
      authToken: value.TWILIO_AUTH_TOKEN,
      from: value.TWILIO_FROM,
      apiUrl: value.TWILIO_API_URL,
      // Twilio signs this exact address, so the webhook route rebuilds it the same way.
      statusCallbackUrl: options.localOnly ? undefined : `${appOrigin(source)}/api/webhooks/twilio`,
    });
  }
  return null;
}
