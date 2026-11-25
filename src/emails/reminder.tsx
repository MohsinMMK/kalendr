import { previewAppointment, previewBrand, type EmailAppointment, type EmailBrand } from "./_shared/brand";
import { AppointmentDetails, CalendarNote, EmailLayout, ManageLink, Paragraph, Title } from "./_shared/layout";

export interface ReminderEmailProps {
  brand: EmailBrand;
  customerName: string;
  appointment: EmailAppointment;
}

export function subject({ brand }: ReminderEmailProps): string {
  return `Reminder: your ${brand.words.appointment} with ${brand.businessName}`;
}

export default function ReminderEmail({ brand, customerName, appointment }: ReminderEmailProps) {
  const { words } = brand;
  return (
    <EmailLayout brand={brand} preview={`Coming up: ${appointment.when}`}>
      <Title>{`Your ${words.appointment} is coming up`}</Title>
      <Paragraph>Hi {customerName},</Paragraph>
      <Paragraph>{`This is a reminder from ${brand.businessName}. If you can no longer make it, please change or cancel so someone else can have the time.`}</Paragraph>
      <AppointmentDetails brand={brand} appointment={appointment} />
      <ManageLink brand={brand} appointment={appointment} />
      <CalendarNote />
    </EmailLayout>
  );
}

ReminderEmail.PreviewProps = { brand: previewBrand, customerName: "Priya", appointment: previewAppointment } satisfies ReminderEmailProps;
