import { previewBrand, type EmailBrand } from "./_shared/brand";
import { ActionButton, EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface WaitlistOfferEmailProps {
  brand: EmailBrand;
  customerName: string;
  /** "Tue, 24 Nov 2026, 4:00 pm IST", in the place's own time zone. */
  when: string;
  serviceName: string;
  /** How long the person has to answer, in minutes. */
  minutes: number;
  /** The private link that takes the time in one tap. */
  offerUrl: string;
}

export function subject({ brand, when }: WaitlistOfferEmailProps): string {
  return `A time opened up at ${brand.businessName}: ${when}`;
}

export default function WaitlistOfferEmail({ brand, customerName, when, serviceName, minutes, offerUrl }: WaitlistOfferEmailProps) {
  return (
    <EmailLayout brand={brand} preview={`A time opened up: ${when}`}>
      <Title>A time just opened up</Title>
      <Paragraph>Hi {customerName},</Paragraph>
      <Paragraph>{`You asked ${brand.businessName} to tell you when a time opened up. ${serviceName} is free on ${when}. Take it within ${minutes} minutes, or it goes to the next person.`}</Paragraph>
      <ActionButton href={offerUrl} accent={brand.accentColor}>Take this time</ActionButton>
      <Paragraph>If you no longer want a time, you can ignore this message.</Paragraph>
    </EmailLayout>
  );
}

WaitlistOfferEmail.PreviewProps = {
  brand: previewBrand, customerName: "Priya", when: "Tue, 24 Nov 2026, 4:00 pm IST", serviceName: "Check-up", minutes: 15, offerUrl: "https://kalendr.example/offer/token",
} satisfies WaitlistOfferEmailProps;
