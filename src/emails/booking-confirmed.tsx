import { previewAppointment, previewBrand, type EmailAppointment, type EmailBrand } from "./_shared/brand";
import { AppointmentDetails, CalendarNote, EmailLayout, ManageLink, Paragraph, Title } from "./_shared/layout";

export interface BookingConfirmedEmailProps {
  brand: EmailBrand;
  customerName: string;
  appointment: EmailAppointment;
}

export function subject({ brand }: BookingConfirmedEmailProps): string {
  return `Your ${brand.words.appointment} with ${brand.businessName} is booked`;
}

export default function BookingConfirmedEmail({ brand, customerName, appointment }: BookingConfirmedEmailProps) {
  const { words } = brand;
  return (
    <EmailLayout brand={brand} preview={`Booked for ${appointment.when}`}>
      <Title>{`Your ${words.appointment} is booked`}</Title>
      <Paragraph>Hi {customerName},</Paragraph>
      <Paragraph>{`${brand.businessName} has you booked. Here are the details.`}</Paragraph>
      <AppointmentDetails brand={brand} appointment={appointment} />
      <ManageLink brand={brand} appointment={appointment} />
      <CalendarNote />
    </EmailLayout>
  );
}

BookingConfirmedEmail.PreviewProps = { brand: previewBrand, customerName: "Priya", appointment: previewAppointment } satisfies BookingConfirmedEmailProps;
