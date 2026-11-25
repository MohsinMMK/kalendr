import { previewBrand, type EmailBrand } from "./_shared/brand";
import { ActionButton, EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface BillingTrialEndingEmailProps {
  brand: EmailBrand;
  /** The day the trial ends, like "2027-02-12". */
  endsOn: string;
  billingUrl: string;
}

export function subject(): string {
  return "Your free trial ends in 3 days";
}

export default function BillingTrialEndingEmail({ brand, endsOn, billingUrl }: BillingTrialEndingEmailProps) {
  return (
    <EmailLayout brand={brand} preview="Pick a plan to keep everything you have now.">
      <Title>Your free trial ends in 3 days</Title>
      <Paragraph>{`Your Growth trial ends on ${endsOn}. After that your business moves to the Free plan: one calendar, one location and 50 bookings a month. Nothing is deleted, and extra calendars become read-only.`}</Paragraph>
      <Paragraph>Pick a plan now to keep your calendars, WhatsApp and text reminders, and online payments.</Paragraph>
      <ActionButton href={billingUrl} accent={brand.accentColor}>Choose a plan</ActionButton>
    </EmailLayout>
  );
}

BillingTrialEndingEmail.PreviewProps = {
  brand: previewBrand,
  endsOn: "2027-02-12",
  billingUrl: "https://kalendr.example/dashboard",
} satisfies BillingTrialEndingEmailProps;
