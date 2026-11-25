import { previewBrand, type EmailBrand } from "./_shared/brand";
import { ActionButton, EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface PrivacyRequestOverdueEmailProps {
  brand: EmailBrand;
  /** "download", "erasure" or "correction". */
  requestKind: string;
  dueOn: string;
  staffUrl: string;
}

export function subject({ requestKind }: PrivacyRequestOverdueEmailProps): string {
  return `A customer ${requestKind} request is overdue`;
}

export default function PrivacyRequestOverdueEmail({ brand, requestKind, dueOn, staffUrl }: PrivacyRequestOverdueEmailProps) {
  return (
    <EmailLayout brand={brand} preview="A privacy request is past its due date">
      <Title>A privacy request is overdue</Title>
      <Paragraph>{`A ${requestKind} request from one of your customers was due on ${dueOn} and has not been dealt with.`}</Paragraph>
      <Paragraph>Open the privacy requests list and approve or refuse it, with a reason.</Paragraph>
      <ActionButton href={staffUrl} accent={brand.accentColor}>Open privacy requests</ActionButton>
    </EmailLayout>
  );
}

PrivacyRequestOverdueEmail.PreviewProps = {
  brand: previewBrand,
  requestKind: "erasure",
  dueOn: "12 Feb 2027",
  staffUrl: "https://kalendr.example/clinic/privacy",
} satisfies PrivacyRequestOverdueEmailProps;
