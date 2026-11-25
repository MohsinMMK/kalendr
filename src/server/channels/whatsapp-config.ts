/**
 * Builds the WhatsApp channel from the environment. Returns null when WhatsApp isn't set up,
 * and in local_capture mode refuses anything but a loopback WHATSAPP_API_URL, so a local worker
 * or a test can never reach Meta.
 */
import { env, isLoopbackUrl, type EnvironmentSource } from "../env";
import { createWhatsAppChannel } from "./whatsapp-cloud";
import type { Channel } from "./types";

export function whatsappChannelFromEnv(options: { localOnly: boolean }, source: EnvironmentSource = process.env): Channel | null {
  const value = env(source);
  if (!value.WHATSAPP_ACCESS_TOKEN || !value.WHATSAPP_PHONE_NUMBER_ID) return null;
  const loopback = isLoopbackUrl(value.WHATSAPP_API_URL);
  if (options.localOnly && !loopback) return null;
  return createWhatsAppChannel({
    accessToken: value.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: value.WHATSAPP_PHONE_NUMBER_ID,
    appSecret: value.WHATSAPP_APP_SECRET,
    apiUrl: value.WHATSAPP_API_URL,
    mode: loopback ? "capture" : "live",
  });
}
