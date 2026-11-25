import "server-only";

import { createHash } from "node:crypto";

import { kalendrBrand } from "@/emails/_shared/brand";

import { emailIsConfigured as emailEnvIsConfigured } from "./env";
import { emailSettingsFromEnv } from "./messaging/email-config";
import { renderEmail, type EmailTemplateName, type EmailTemplateProps } from "./messaging/email-templates";

export function emailIsConfigured(): boolean {
  return emailEnvIsConfigured();
}

/**
 * The provider key for one account email. The link holds a one-time token, so the same link
 * is the same email: a double click or a retried request sends it once.
 */
function accountEmailKey(template: EmailTemplateName, uniquePart: string): string {
  return `account:${template}:${createHash("sha256").update(uniquePart).digest("hex")}`;
}

/**
 * Renders one account email and hands it to the email provider. Never logs the address, the
 * link or the provider's response body; errors carry a short code only.
 */
export async function sendAccountEmail<N extends EmailTemplateName>(
  to: string,
  template: N,
  props: EmailTemplateProps<N>,
  uniquePart: string,
  fromName?: string,
): Promise<void> {
  const settings = emailSettingsFromEnv({ localOnly: false });
  if (!settings) throw new Error("Email delivery is not configured.");
  const rendered = await renderEmail(template, props);
  await settings.provider.send({
    to,
    fromName,
    replyTo: settings.fallbackReplyTo ?? undefined,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    idempotencyKey: accountEmailKey(template, uniquePart),
  });
}

/**
 * Sends an account link. Without an email provider, development prints the link to the
 * server console so the flow can be tried locally; production reports that nothing was sent
 * and the person who asked shares the link themselves.
 */
async function sendAccountLink(send: () => Promise<void>, subject: string, link: string): Promise<boolean> {
  if (emailIsConfigured()) {
    await send();
    return true;
  }
  if (process.env.NODE_ENV !== "production") {
    console.info(`[kalendr] Email delivery is not configured. ${subject}: ${link}`);
  }
  return false;
}

export async function sendVerificationEmail(email: string, verificationUrl: string): Promise<void> {
  if (!emailIsConfigured()) throw new Error("Verification email delivery is not configured.");
  await sendAccountEmail(email, "email_verification", { url: verificationUrl }, verificationUrl, kalendrBrand.businessName);
}

export function sendInviteEmail(input: { email: string; name: string; clinicName: string; inviterName: string; url: string; existingLogin?: boolean }): Promise<boolean> {
  return sendAccountLink(
    () => sendAccountEmail(input.email, "staff_invite", {
      name: input.name,
      inviterName: input.inviterName,
      brand: { ...kalendrBrand, businessName: input.clinicName },
      url: input.url,
      ...(input.existingLogin ? { existingLogin: true } : {}),
    }, input.url, input.clinicName),
    "Staff invite",
    input.url,
  );
}

export function sendPasswordResetEmail(input: { email: string; name: string; url: string }): Promise<boolean> {
  return sendAccountLink(
    () => sendAccountEmail(input.email, "password_reset", { name: input.name, url: input.url }, input.url, kalendrBrand.businessName),
    "Password reset",
    input.url,
  );
}

export function sendMagicLinkEmail(input: { email: string; url: string }): Promise<boolean> {
  return sendAccountLink(
    () => sendAccountEmail(input.email, "magic_link", { url: input.url }, input.url, kalendrBrand.businessName),
    "Sign-in link",
    input.url,
  );
}

/** Best-effort notices: with no email provider nothing is sent, and they never throw, so a failed notice can't block sign-in. The audit trail still records the event. */
export async function sendNewDeviceNotice(email: string, props: EmailTemplateProps<"new_device_sign_in">, uniquePart: string): Promise<void> {
  if (!emailIsConfigured()) return;
  await sendAccountEmail(email, "new_device_sign_in", props, uniquePart, kalendrBrand.businessName).catch(() => undefined);
}

export async function sendSecurityChangeNotice(email: string, props: EmailTemplateProps<"security_change">, uniquePart: string): Promise<void> {
  if (!emailIsConfigured()) return;
  await sendAccountEmail(email, "security_change", props, uniquePart, kalendrBrand.businessName).catch(() => undefined);
}

/**
 * The link that confirms a new sign-in email, sent to the NEW address. Like the other account links it goes out in the request,
 * because it carries a one-time token that must not sit in the outbox table; without an email provider, development prints it.
 */
export function sendEmailChangeConfirmation(input: { email: string; name: string; url: string }): Promise<boolean> {
  return sendAccountLink(
    () => sendAccountEmail(input.email, "account_email_change", { kind: "confirm", name: input.name, url: input.url }, input.url, kalendrBrand.businessName),
    "Confirm new sign-in email",
    input.url,
  );
}
