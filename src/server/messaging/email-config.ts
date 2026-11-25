/**
 * Builds the email provider from the environment. Returns null when email isn't set up, and
 * in local_capture mode refuses anything but a loopback EMAIL_API_URL, so a local worker or a
 * test can never reach a real provider.
 */
import { emailApiIsLoopback, emailApiUrl, env, type EnvironmentSource } from "../env";
import { createResendEmailProvider } from "./email-resend";
import type { MessageProvider } from "./provider";

export interface EmailSettings {
  provider: MessageProvider;
  /** Reply-To when the business has no email of its own. */
  fallbackReplyTo: string | null;
}

export function emailSettingsFromEnv(options: { localOnly: boolean }, source: EnvironmentSource = process.env): EmailSettings | null {
  const value = env(source);
  if (!value.RESEND_API_KEY || !value.EMAIL_FROM) return null;
  if (options.localOnly && !emailApiIsLoopback(source)) return null;
  return {
    provider: createResendEmailProvider({ apiKey: value.RESEND_API_KEY, from: value.EMAIL_FROM, apiUrl: emailApiUrl(source) }),
    fallbackReplyTo: value.EMAIL_REPLY_TO ?? null,
  };
}
