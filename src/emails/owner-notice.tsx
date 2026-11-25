import { previewBrand, type EmailBrand } from "./_shared/brand";
import { ActionButton, EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface OwnerNoticeEmailProps {
  brand: EmailBrand;
  subject: string;
  heading: string;
  /** Plain sentences, one per paragraph. Written by Kalendr (src/lib/owner-notices.ts), never by a customer. */
  paragraphs: string[];
  button?: { label: string; url: string };
}

export function subject({ subject: text }: Pick<OwnerNoticeEmailProps, "subject">): string {
  return text;
}

/** One layout for Kalendr's own mail to a business owner: address warnings, onboarding nudges. */
export default function OwnerNoticeEmail({ brand, heading, paragraphs, button }: OwnerNoticeEmailProps) {
  return (
    <EmailLayout brand={brand} preview={paragraphs[0] ?? heading}>
      <Title>{heading}</Title>
      {paragraphs.map((text) => <Paragraph key={text}>{text}</Paragraph>)}
      {button ? <ActionButton href={button.url} accent={brand.accentColor}>{button.label}</ActionButton> : null}
    </EmailLayout>
  );
}

OwnerNoticeEmail.PreviewProps = {
  brand: previewBrand,
  subject: "Your web address needs attention",
  heading: "Your web address needs attention",
  paragraphs: ["We could not find the records for book.example.com."],
  button: { label: "Open settings", url: "https://kalendr.example/settings" },
} satisfies OwnerNoticeEmailProps;
