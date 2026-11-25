import { previewAppointment, previewBrand, type EmailAppointment, type EmailBrand } from "./_shared/brand";
import { AppointmentDetails, EmailLayout, ManageLink, Paragraph, Title } from "./_shared/layout";

export interface RequestExpiredEmailProps {
  brand: EmailBrand;
  customerName: string;
  appointment: EmailAppointment;
  /** The business's booking page, or null. */
  bookAgainUrl?: string | null;
}

export function subject({ brand }: RequestExpiredEmailProps): string {
  return `Your ${brand.words.appointment} request with ${brand.businessName} has closed`;
}

export default function RequestExpiredEmail({ brand, customerName, appointment, bookAgainUrl }: RequestExpiredEmailProps) {
  const { words } = brand;
  return (
    <EmailLayout brand={brand} preview={`Request closed: ${appointment.when}`}>
      <Title>{`Your ${words.appointment} request has closed`}</Title>
      <Paragraph>Hi {customerName},</Paragraph>
      <Paragraph>{`${brand.businessName} did not answer before the time you asked for, so the request has closed. You are welcome to ask for another time.`}</Paragraph>
      <AppointmentDetails brand={brand} appointment={appointment} />
      {bookAgainUrl ? <ManageLink brand={brand} appointment={{ ...appointment, manageUrl: bookAgainUrl }} label="Book another time" /> : null}
    </EmailLayout>
  );
}

RequestExpiredEmail.PreviewProps = { brand: previewBrand, customerName: "Priya", appointment: previewAppointment, bookAgainUrl: "https://kalendr.example/b/sunrise-dental" } satisfies RequestExpiredEmailProps;
