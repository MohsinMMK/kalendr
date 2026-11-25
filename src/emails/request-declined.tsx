import { previewAppointment, previewBrand, type EmailAppointment, type EmailBrand } from "./_shared/brand";
import { AppointmentDetails, EmailLayout, ManageLink, Paragraph, Title } from "./_shared/layout";

export interface RequestDeclinedEmailProps {
  brand: EmailBrand;
  customerName: string;
  appointment: EmailAppointment;
  /** The reason and the note the business wrote, as one plain sentence or two. */
  explanation?: string | null;
  /** The business's booking page, or null. */
  bookAgainUrl?: string | null;
}

export function subject({ brand }: RequestDeclinedEmailProps): string {
  return `${brand.businessName} could not accept your ${brand.words.appointment} request`;
}

export default function RequestDeclinedEmail({ brand, customerName, appointment, explanation, bookAgainUrl }: RequestDeclinedEmailProps) {
  const { words } = brand;
  return (
    <EmailLayout brand={brand} preview={`Not accepted: ${appointment.when}`}>
      <Title>{`We could not accept your ${words.appointment} request`}</Title>
      <Paragraph>Hi {customerName},</Paragraph>
      <Paragraph>{explanation || `Sorry, ${brand.businessName} cannot take this request.`}</Paragraph>
      <AppointmentDetails brand={brand} appointment={appointment} />
      {bookAgainUrl ? <ManageLink brand={brand} appointment={{ ...appointment, manageUrl: bookAgainUrl }} label="Book another time" /> : null}
    </EmailLayout>
  );
}

RequestDeclinedEmail.PreviewProps = { brand: previewBrand, customerName: "Priya", appointment: previewAppointment, explanation: "We are fully booked that day.", bookAgainUrl: "https://kalendr.example/b/sunrise-dental" } satisfies RequestDeclinedEmailProps;
