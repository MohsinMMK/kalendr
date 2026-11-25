import { previewBrand, type EmailBrand } from "./_shared/brand";
import { ActionButton, EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface BillingUsageAlertEmailProps {
  brand: EmailBrand;
  /** "WhatsApp" or "text". */
  channelLabel: string;
  threshold: 80 | 100;
  used: number;
  included: number;
  billingUrl: string;
}

export function subject({ channelLabel, threshold }: BillingUsageAlertEmailProps): string {
  return threshold === 100 ? `You've used all your included ${channelLabel} messages` : `You've used ${threshold}% of your ${channelLabel} messages`;
}

export default function BillingUsageAlertEmail({ brand, channelLabel, threshold, used, included, billingUrl }: BillingUsageAlertEmailProps) {
  const full = threshold === 100;
  return (
    <EmailLayout brand={brand} preview={`${used} of ${included} ${channelLabel} messages used this month.`}>
      <Title>{full ? `All your included ${channelLabel} messages are used` : `${threshold}% of your ${channelLabel} messages are used`}</Title>
      <Paragraph>{`This month you have sent ${used} of the ${included} ${channelLabel} messages your plan includes.`}</Paragraph>
      <Paragraph>
        {full
          ? "Appointment confirmations and reminders keep going out as normal. What happens to marketing messages is your choice in Plan and billing: stop them, or keep sending and pay for the extra."
          : "Appointment confirmations and reminders will keep going out. You can move to a bigger plan, or choose what happens to marketing messages once the amount is used."}
      </Paragraph>
      <ActionButton href={billingUrl} accent={brand.accentColor}>Open Plan and billing</ActionButton>
    </EmailLayout>
  );
}

BillingUsageAlertEmail.PreviewProps = {
  brand: previewBrand,
  channelLabel: "WhatsApp",
  threshold: 80,
  used: 160,
  included: 200,
  billingUrl: "https://kalendr.example/dashboard",
} satisfies BillingUsageAlertEmailProps;
