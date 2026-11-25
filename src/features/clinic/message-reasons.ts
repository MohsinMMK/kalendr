/**
 * Delivery and failure codes in plain words. The worker and the webhook store codes only,
 * never a provider's message, an address or a body.
 */
export function messageReason(code: string | null | undefined): string | null {
  if (!code) return null;
  switch (code) {
    case "suppressed_bounced": return "Not sent: this address bounced before.";
    case "suppressed_complained": return "Not sent: this address marked an earlier email as spam.";
    case "no_destination": return "Not sent: no email address on file.";
    case "appointment_not_found": return "Not sent: the booking no longer exists.";
    case "bounced": return "Bounced: the address doesn't exist.";
    case "bounced_soft": return "Bounced for now: the mailbox may be full.";
    case "provider_failed": return "The email provider couldn't send it.";
    case "provider_not_configured": return "No provider is connected for this channel.";
    case "email_network_error": return "The email provider couldn't be reached.";
    case "provider_error": return "The provider refused it.";
    default:
      if (code.startsWith("resend_")) return "The email provider refused it.";
      return null;
  }
}
