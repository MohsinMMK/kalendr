import { previewAppointment, previewBrand, type EmailAppointment, type EmailBrand } from "./_shared/brand";
import { AppointmentDetails, CalendarNote, EmailLayout, ManageLink, Paragraph, Title } from "./_shared/layout";

export interface CancelledEmailProps {
  brand: EmailBrand;
  customerName: string;
  appointment: EmailAppointment;
  /** The business's booking page, or null. */
  bookAgainUrl?: string | null;
}

export function subject({ brand }: CancelledEmailProps): string {
  return `Your ${brand.words.appointment} with ${brand.businessName} is cancelled`;
}

export default function CancelledEmail({ brand, customerName, appointment, bookAgainUrl }: CancelledEmailProps) {
  const { words } = brand;
  return (
    <EmailLayout brand={brand} preview={`Cancelled: ${appointment.when}`}>
      <Title>{`Your ${words.appointment} is cancelled`}</Title>
      <Paragraph>Hi {customerName},</Paragraph>
      <Paragraph>{`This ${words.appointment} with ${brand.businessName} is cancelled. You don't need to do anything else.`}</Paragraph>
      <AppointmentDetails brand={brand} appointment={appointment} />
      {bookAgainUrl ? <ManageLink brand={brand} appointment={{ ...appointment, manageUrl: bookAgainUrl }} label="Book another time" /> : null}
      <CalendarNote />
    </EmailLayout>
  );
}

CancelledEmail.PreviewProps = { brand: previewBrand, customerName: "Priya", appointment: previewAppointment, bookAgainUrl: "https://kalendr.example/b/sunrise-dental" } satisfies CancelledEmailProps;
