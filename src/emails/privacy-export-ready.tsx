import { previewBrand, type EmailBrand } from "./_shared/brand";
import { ActionButton, EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface PrivacyExportReadyEmailProps {
  brand: EmailBrand;
  customerName: string;
  /** The one-time download link. It works once. */
  url: string;
  validDays: number;
}

export function subject({ brand }: PrivacyExportReadyEmailProps): string {
  return `Your data from ${brand.businessName} is ready to download`;
}

export default function PrivacyExportReadyEmail({ brand, customerName, url, validDays }: PrivacyExportReadyEmailProps) {
  return (
    <EmailLayout brand={brand} preview="Your data is ready to download">
      <Title>Your data is ready</Title>
      <Paragraph>Hi {customerName},</Paragraph>
      <Paragraph>{`You asked ${brand.businessName} for a copy of the information they hold about you. It is ready.`}</Paragraph>
      <ActionButton href={url} accent={brand.accentColor}>Download your data</ActionButton>
      <Paragraph>{`The link works once and expires in ${validDays} days. The file has your details in a readable document and in a data file. Keep it somewhere private.`}</Paragraph>
      <Paragraph>If you didn&apos;t ask for this, don&apos;t open the link and tell the business.</Paragraph>
    </EmailLayout>
  );
}

PrivacyExportReadyEmail.PreviewProps = {
  brand: previewBrand,
  customerName: "Priya",
  url: "https://kalendr.example/api/portal/privacy/export/sample",
  validDays: 7,
} satisfies PrivacyExportReadyEmailProps;
