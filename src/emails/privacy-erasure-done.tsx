import { previewBrand, type EmailBrand } from "./_shared/brand";
import { EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface PrivacyErasureDoneEmailProps {
  brand: EmailBrand;
  customerName: string;
  /** Plain sentences: what was removed. */
  removed: string[];
  /** Plain sentences: what was kept, and why. */
  kept: string[];
}

export function subject({ brand }: PrivacyErasureDoneEmailProps): string {
  return `${brand.businessName} has erased your details`;
}

export default function PrivacyErasureDoneEmail({ brand, customerName, removed, kept }: PrivacyErasureDoneEmailProps) {
  return (
    <EmailLayout brand={brand} preview="Your erasure request is done">
      <Title>Your request is done</Title>
      <Paragraph>Hi {customerName},</Paragraph>
      <Paragraph>{`${brand.businessName} approved your request to erase your details. Here is what happened.`}</Paragraph>
      <Paragraph>What was removed:</Paragraph>
      {removed.map((line) => <Paragraph key={line}>{`• ${line}`}</Paragraph>)}
      {kept.length > 0 ? <Paragraph>What was kept, and why:</Paragraph> : null}
      {kept.map((line) => <Paragraph key={line}>{`• ${line}`}</Paragraph>)}
      <Paragraph>If you have a question about this, contact the business directly.</Paragraph>
    </EmailLayout>
  );
}

PrivacyErasureDoneEmail.PreviewProps = {
  brand: previewBrand,
  customerName: "Priya",
  removed: ["Your name, phone number, email address and date of birth", "Notes and form answers on your bookings"],
  kept: ["Payment records, for the period the business must keep them by law"],
} satisfies PrivacyErasureDoneEmailProps;
