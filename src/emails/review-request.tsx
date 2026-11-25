import { previewAppointment, previewBrand, type EmailAppointment, type EmailBrand } from "./_shared/brand";
import { EmailLayout, ManageLink, Paragraph, Title } from "./_shared/layout";

export interface ReviewRequestEmailProps {
  brand: EmailBrand;
  customerName: string;
  appointment: EmailAppointment;
}

export function subject({ brand }: ReviewRequestEmailProps): string {
  return `How was your ${brand.words.appointment} with ${brand.businessName}?`;
}

export default function ReviewRequestEmail({ brand, customerName, appointment }: ReviewRequestEmailProps) {
  const { words } = brand;
  return (
    <EmailLayout brand={brand} preview={"Tell us how it went"}>
      <Title>How did it go?</Title>
      <Paragraph>Hi {customerName},</Paragraph>
      <Paragraph>{`Thanks for visiting ${brand.businessName}. A quick rating helps them, and helps other ${words.customers} choose.`}</Paragraph>
      <ManageLink brand={brand} appointment={appointment} label="Leave a review" />
    </EmailLayout>
  );
}

ReviewRequestEmail.PreviewProps = { brand: previewBrand, customerName: "Priya", appointment: previewAppointment } satisfies ReviewRequestEmailProps;
