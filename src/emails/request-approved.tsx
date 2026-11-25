import { previewAppointment, previewBrand, type EmailAppointment, type EmailBrand } from "./_shared/brand";
import { AppointmentDetails, CalendarNote, EmailLayout, ManageLink, Paragraph, Title } from "./_shared/layout";

export interface RequestApprovedEmailProps {
  brand: EmailBrand;
  customerName: string;
  appointment: EmailAppointment;
}

export function subject({ brand }: RequestApprovedEmailProps): string {
  return `${brand.businessName} confirmed your ${brand.words.appointment}`;
}

export default function RequestApprovedEmail({ brand, customerName, appointment }: RequestApprovedEmailProps) {
  const { words } = brand;
  return (
    <EmailLayout brand={brand} preview={`Confirmed for ${appointment.when}`}>
      <Title>{`Your ${words.appointment} is confirmed`}</Title>
      <Paragraph>Hi {customerName},</Paragraph>
      <Paragraph>{`Good news: ${brand.businessName} accepted your request.`}</Paragraph>
      <AppointmentDetails brand={brand} appointment={appointment} />
      <ManageLink brand={brand} appointment={appointment} />
      <CalendarNote />
    </EmailLayout>
  );
}

RequestApprovedEmail.PreviewProps = { brand: previewBrand, customerName: "Priya", appointment: previewAppointment } satisfies RequestApprovedEmailProps;
