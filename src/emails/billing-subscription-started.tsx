import { previewBrand, type EmailBrand } from "./_shared/brand";
import { ActionButton, EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface BillingSubscriptionStartedEmailProps {
  brand: EmailBrand;
  planName: string;
  billingUrl: string;
}

export function subject({ planName }: BillingSubscriptionStartedEmailProps): string {
  return `You're on the ${planName} plan`;
}

export default function BillingSubscriptionStartedEmail({ brand, planName, billingUrl }: BillingSubscriptionStartedEmailProps) {
  return (
    <EmailLayout brand={brand} preview={`Your ${planName} plan is active.`}>
      <Title>{`You're on the ${planName} plan`}</Title>
      <Paragraph>Thank you. Your payment went through and your plan is active now.</Paragraph>
      <Paragraph>Your tax invoice is in Plan and billing, where you can also change plan or cancel at any time.</Paragraph>
      <ActionButton href={billingUrl} accent={brand.accentColor}>Open Plan and billing</ActionButton>
    </EmailLayout>
  );
}

BillingSubscriptionStartedEmail.PreviewProps = {
  brand: previewBrand,
  planName: "Growth",
  billingUrl: "https://kalendr.example/dashboard",
} satisfies BillingSubscriptionStartedEmailProps;
