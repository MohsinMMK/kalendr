import { previewAppointment, previewBrand, type EmailAppointment, type EmailBrand } from "./_shared/brand";
import { AppointmentDetails, CalendarNote, EmailLayout, ManageLink, Paragraph, Title } from "./_shared/layout";

export interface VisitChangedEmailProps {
  brand: EmailBrand;
  customerName: string;
  appointment: EmailAppointment;
  /** What changed, as a short title ("Your appointment is now with someone else"). */
  headline: string;
  /** One or two plain sentences. */
  summary: string;
}

export function subject({ brand, headline }: VisitChangedEmailProps): string {
  return `${brand.businessName}: ${headline}`;
}

export default function VisitChangedEmail({ brand, customerName, appointment, headline, summary }: VisitChangedEmailProps) {
  return (
    <EmailLayout brand={brand} preview={headline}>
      <Title>{headline}</Title>
      <Paragraph>Hi {customerName},</Paragraph>
      <Paragraph>{summary}</Paragraph>
      <AppointmentDetails brand={brand} appointment={appointment} />
      <ManageLink brand={brand} appointment={appointment} />
      <CalendarNote />
    </EmailLayout>
  );
}

VisitChangedEmail.PreviewProps = { brand: previewBrand, customerName: "Priya", appointment: previewAppointment, headline: "Your appointment is now with someone else", summary: "The time and place have not changed." } satisfies VisitChangedEmailProps;
