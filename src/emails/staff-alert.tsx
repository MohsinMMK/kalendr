import { previewBrand, type EmailBrand } from "./_shared/brand";
import { ActionButton, EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface StaffAlertEmailProps {
  brand: EmailBrand;
  title: string;
  /** The customer's first name, the service and the time. Never a phone, email or note. */
  detail: string;
  url: string;
}

export function subject({ title }: StaffAlertEmailProps): string {
  return title;
}

export default function StaffAlertEmail({ brand, title, detail, url }: StaffAlertEmailProps) {
  return (
    <EmailLayout brand={brand} preview={detail || title}>
      <Title>{title}</Title>
      {detail ? <Paragraph>{detail}</Paragraph> : null}
      <ActionButton href={url} accent={brand.accentColor}>Open it</ActionButton>
      <Paragraph>You get this because you chose email for this kind of alert. Change it any time under Notifications in your profile menu.</Paragraph>
    </EmailLayout>
  );
}

StaffAlertEmail.PreviewProps = {
  brand: previewBrand,
  title: "New booking at 4:30 pm",
  detail: "Asha · Dental consultation · 4:30 pm",
  url: "https://kalendr.example/schedule",
} satisfies StaffAlertEmailProps;
