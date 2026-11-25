import { Button, Link, Section, Text } from "react-email";
import type { ReactNode } from "react";

import { previewBrand, safeAccent, type EmailBrand } from "./_shared/brand";
import { EmailLayout, Paragraph, styles } from "./_shared/layout";

/**
 * A marketing message from a campaign (feature 28). The owner's words are already filled in for this customer; this lays
 * them out, adds the booking button, and ends with the unsubscribe line every marketing email must carry.
 */
export interface CampaignMessageEmailProps {
  brand: EmailBrand;
  subject: string;
  body: string;
  bookUrl: string;
  unsubscribeUrl: string;
}

export function subject(props: CampaignMessageEmailProps): string {
  return props.subject;
}

const URL_PATTERN = /(https?:\/\/[^\s<>"]+)/g;

function withLinks(line: string, accent: string): ReactNode[] {
  return line.split(URL_PATTERN).map((part, index) =>
    index % 2 === 1
      ? <Link key={index} href={part} style={{ color: accent, textDecoration: "underline" }}>{part}</Link>
      : part,
  );
}

export default function CampaignMessageEmail({ brand, subject: heading, body, bookUrl, unsubscribeUrl }: CampaignMessageEmailProps) {
  const accent = safeAccent(brand.accentColor);
  // The booking address already sits in the text as a link when the owner used it; the button is for those who did not.
  const hasLinkInText = body.includes(bookUrl);
  const paragraphs = body.split(/\n{2,}/).map((block) => block.split("\n"));
  return (
    <EmailLayout brand={brand} preview={heading}>
      {paragraphs.map((lines, index) => (
        <Paragraph key={index}>
          {lines.flatMap((line, lineIndex) => [lineIndex > 0 ? <br key={`br-${lineIndex}`} /> : null, ...withLinks(line, accent)])}
        </Paragraph>
      ))}
      {hasLinkInText ? null : (
        <Section style={{ margin: "8px 0 16px" }}>
          <Button href={bookUrl} style={{ backgroundColor: accent, borderRadius: "6px", color: "#ffffff", fontSize: "15px", fontWeight: 600, padding: "12px 20px", textDecoration: "none" }}>
            Book a time
          </Button>
        </Section>
      )}
      <Text style={styles.muted}>
        You are getting this because you agreed to marketing messages from {brand.businessName}.{" "}
        <Link href={unsubscribeUrl} style={{ color: "#52525b", textDecoration: "underline" }}>Unsubscribe</Link>. You will still get messages about your bookings.
      </Text>
    </EmailLayout>
  );
}

CampaignMessageEmail.PreviewProps = {
  brand: previewBrand,
  subject: "Time for your check-up?",
  body: "Hi Priya,\n\nIt has been a while since your last check-up with Riverbend Care. If you'd like to book, pick a time here.",
  bookUrl: "https://kalendr.example/book/riverbend?utm_campaign=cmp",
  unsubscribeUrl: "https://kalendr.example/api/public/unsubscribe/token",
} satisfies CampaignMessageEmailProps;
