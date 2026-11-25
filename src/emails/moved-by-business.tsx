import { previewAppointment, previewBrand, type EmailAppointment, type EmailBrand } from "./_shared/brand";
import { AppointmentDetails, CalendarNote, EmailLayout, ManageLink, Paragraph, Title } from "./_shared/layout";

export interface MovedByBusinessEmailProps {
  brand: EmailBrand;
  customerName: string;
  appointment: EmailAppointment;
  /** The old time, when it is known. */
  previousWhen?: string | null;
}

export function subject({ brand }: MovedByBusinessEmailProps): string {
  return `${brand.businessName} moved your ${brand.words.appointment}`;
}

export default function MovedByBusinessEmail({ brand, customerName, appointment, previousWhen }: MovedByBusinessEmailProps) {
  const { words } = brand;
  return (
    <EmailLayout brand={brand} preview={`New time: ${appointment.when}`}>
      <Title>{`${brand.businessName} moved your ${words.appointment}`}</Title>
      <Paragraph>Hi {customerName},</Paragraph>
      <Paragraph>{`${brand.businessName} needed to change the time of your ${words.appointment}. If the new time doesn't suit you, pick another one or cancel using the button below.`}</Paragraph>
      <AppointmentDetails brand={brand} appointment={appointment} previousWhen={previousWhen} />
      <ManageLink brand={brand} appointment={appointment} label="Keep, move or cancel" />
      <CalendarNote />
    </EmailLayout>
  );
}

MovedByBusinessEmail.PreviewProps = { brand: previewBrand, customerName: "Priya", appointment: previewAppointment, previousWhen: "Fri, 13 Nov 2026, 4:00 pm IST" } satisfies MovedByBusinessEmailProps;
