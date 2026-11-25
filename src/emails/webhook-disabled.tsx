import { previewBrand, type EmailBrand } from "./_shared/brand";
import { ActionButton, EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface WebhookDisabledEmailProps {
  brand: EmailBrand;
  /** Only the host of the address, never the full address and never anything the receiver replied. */
  host: string;
  staffUrl: string;
}

export function subject({ host }: WebhookDisabledEmailProps): string {
  return `Webhook address ${host} was switched off`;
}

export default function WebhookDisabledEmail({ brand, host, staffUrl }: WebhookDisabledEmailProps) {
  return (
    <EmailLayout brand={brand} preview="A webhook address was switched off after repeated failures">
      <Title>A webhook address was switched off</Title>
      <Paragraph>{`Kalendr could not reach ${host} many times in a row, so it stopped sending events there.`}</Paragraph>
      <Paragraph>Check that the receiver is running, then switch the address back on in Developers settings. Events that happened while it was off are not sent again automatically; you can resend them from the delivery log.</Paragraph>
      <ActionButton href={staffUrl} accent={brand.accentColor}>Open Developers settings</ActionButton>
    </EmailLayout>
  );
}

WebhookDisabledEmail.PreviewProps = {
  brand: previewBrand,
  host: "hooks.example.com",
  staffUrl: "https://kalendr.example/dashboard",
} satisfies WebhookDisabledEmailProps;
