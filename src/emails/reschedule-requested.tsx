import { previewAppointment, previewBrand, type EmailAppointment, type EmailBrand } from "./_shared/brand";
import { AppointmentDetails, EmailLayout, ManageLink, Paragraph, Title } from "./_shared/layout";

export interface RescheduleRequestedEmailProps {
  brand: EmailBrand;
  customerName: string;
  appointment: EmailAppointment;
  /** What the business wrote for the customer, as plain text. */
  note?: string | null;
}

export function subject({ brand }: RescheduleRequestedEmailProps): string {
  return `${brand.businessName} asks you to choose a new time`;
}

export default function RescheduleRequestedEmail({ brand, customerName, appointment, note }: RescheduleRequestedEmailProps) {
  const { words } = brand;
  return (
    <EmailLayout brand={brand} preview={`Please choose a new time for ${appointment.when}`}>
      <Title>{`Please choose a new time for your ${words.appointment}`}</Title>
      <Paragraph>Hi {customerName},</Paragraph>
      <Paragraph>{`${brand.businessName} can't keep the time below. Your ${words.appointment} is still yours: pick a new time that suits you and it's confirmed.`}</Paragraph>
      {note ? <Paragraph>{note}</Paragraph> : null}
      <AppointmentDetails brand={brand} appointment={appointment} />
      <ManageLink brand={brand} appointment={appointment} label="Choose a new time" />
    </EmailLayout>
  );
}

RescheduleRequestedEmail.PreviewProps = { brand: previewBrand, customerName: "Priya", appointment: previewAppointment, note: "The doctor is unwell." } satisfies RescheduleRequestedEmailProps;
