import { previewBrand, type EmailBrand } from "./_shared/brand";
import { ActionButton, EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface RecordSharedEmailProps {
  brand: EmailBrand;
  customerName: string;
  /** Where the customer signs in to see it. The email never names the document. */
  portalUrl: string;
}

export function subject({ brand }: RecordSharedEmailProps): string {
  return `${brand.businessName} shared a document with you`;
}

export default function RecordSharedEmail({ brand, customerName, portalUrl }: RecordSharedEmailProps) {
  return (
    <EmailLayout brand={brand} preview="A new document is ready">
      <Title>A new document is ready</Title>
      <Paragraph>Hi {customerName},</Paragraph>
      <Paragraph>{`${brand.businessName} shared something with you. Sign in to your ${brand.words.customer} portal to see it.`}</Paragraph>
      <ActionButton href={portalUrl} accent={brand.accentColor}>Sign in to see it</ActionButton>
    </EmailLayout>
  );
}

RecordSharedEmail.PreviewProps = { brand: previewBrand, customerName: "Priya", portalUrl: "https://kalendr.example/portal" } satisfies RecordSharedEmailProps;
