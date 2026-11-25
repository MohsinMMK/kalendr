import { previewAppointment, previewBrand, type EmailAppointment, type EmailBrand } from "./_shared/brand";
import { AppointmentDetails, CalendarNote, EmailLayout, ManageLink, Paragraph, Title } from "./_shared/layout";

export interface RescheduledEmailProps {
  brand: EmailBrand;
  customerName: string;
  appointment: EmailAppointment;
  /** The old time, when it is known. */
  previousWhen?: string | null;
}

export function subject({ brand }: RescheduledEmailProps): string {
  return `Your ${brand.words.appointment} with ${brand.businessName} has a new time`;
}

export default function RescheduledEmail({ brand, customerName, appointment, previousWhen }: RescheduledEmailProps) {
  const { words } = brand;
  return (
    <EmailLayout brand={brand} preview={`Moved to ${appointment.when}`}>
      <Title>{`Your ${words.appointment} has a new time`}</Title>
      <Paragraph>Hi {customerName},</Paragraph>
      <Paragraph>{`Your ${words.appointment} with ${brand.businessName} was moved. The new time is below.`}</Paragraph>
      <AppointmentDetails brand={brand} appointment={appointment} previousWhen={previousWhen} />
      <ManageLink brand={brand} appointment={appointment} />
      <CalendarNote />
    </EmailLayout>
  );
}

RescheduledEmail.PreviewProps = { brand: previewBrand, customerName: "Priya", appointment: previewAppointment, previousWhen: "Fri, 13 Nov 2026, 4:00 pm IST" } satisfies RescheduledEmailProps;
