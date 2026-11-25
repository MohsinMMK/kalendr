import { previewBrand, type EmailBrand } from "./_shared/brand";
import { ActionButton, EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface BillingPaymentFailedEmailProps {
  brand: EmailBrand;
  planName: string;
  /** The day full service ends if the payment is still unpaid, like "2027-02-12". Empty when unknown. */
  graceEndsOn: string;
  billingUrl: string;
}

export function subject({ planName }: BillingPaymentFailedEmailProps): string {
  return `Your ${planName} payment didn't go through`;
}

export default function BillingPaymentFailedEmail({ brand, planName, graceEndsOn, billingUrl }: BillingPaymentFailedEmailProps) {
  return (
    <EmailLayout brand={brand} preview="Your payment didn't go through. Everything still works for now.">
      <Title>Your payment didn&apos;t go through</Title>
      <Paragraph>{`We couldn't take the payment for your ${planName} plan. Your bookings, reminders and everything else keep working as normal while we try again.`}</Paragraph>
      <Paragraph>{graceEndsOn ? `If it still fails, your plan moves to Free on ${graceEndsOn}. Nothing is deleted.` : "If it still fails, your plan moves to Free after seven days. Nothing is deleted."}</Paragraph>
      <Paragraph>Please check your payment method in Plan and billing.</Paragraph>
      <ActionButton href={billingUrl} accent={brand.accentColor}>Open Plan and billing</ActionButton>
    </EmailLayout>
  );
}

BillingPaymentFailedEmail.PreviewProps = {
  brand: previewBrand,
  planName: "Starter",
  graceEndsOn: "2027-02-12",
  billingUrl: "https://kalendr.example/dashboard",
} satisfies BillingPaymentFailedEmailProps;
