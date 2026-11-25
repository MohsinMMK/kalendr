import { previewAppointment, previewBrand, type EmailAppointment, type EmailBrand } from "./_shared/brand";
import { AppointmentDetails, CalendarNote, EmailLayout, ManageLink, Paragraph, Title } from "./_shared/layout";

export interface RequestReceivedEmailProps {
  brand: EmailBrand;
  customerName: string;
  appointment: EmailAppointment;
}

export function subject({ brand }: RequestReceivedEmailProps): string {
  return `${brand.businessName} has your request`;
}

export default function RequestReceivedEmail({ brand, customerName, appointment }: RequestReceivedEmailProps) {
  const { words } = brand;
  return (
    <EmailLayout brand={brand} preview={`Requested for ${appointment.when}`}>
      <Title>We have your request</Title>
      <Paragraph>Hi {customerName},</Paragraph>
      <Paragraph>{`${brand.businessName} will look at your request and let you know once the ${words.appointment} is confirmed. Nothing is booked until then.`}</Paragraph>
      <AppointmentDetails brand={brand} appointment={appointment} />
      <ManageLink brand={brand} appointment={appointment} label="View your request" />
      <CalendarNote />
    </EmailLayout>
  );
}

RequestReceivedEmail.PreviewProps = { brand: previewBrand, customerName: "Priya", appointment: previewAppointment } satisfies RequestReceivedEmailProps;
