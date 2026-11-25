import { kalendrBrand, type EmailBrand } from "./_shared/brand";
import { EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface ContactChangedEmailProps {
  brand?: Pick<EmailBrand, "businessName" | "logoUrl" | "accentColor">;
}

export function subject({ brand = kalendrBrand }: ContactChangedEmailProps): string {
  return `Contact details changed on your booking with ${brand.businessName}`;
}

/** Sent to the contact that was not changed. It says that details changed and never says what the new ones are. */
export default function ContactChangedEmail({ brand = kalendrBrand }: ContactChangedEmailProps) {
  return (
    <EmailLayout brand={brand} preview="The contact details on your booking were changed">
      <Title>Contact details changed</Title>
      <Paragraph>The phone number or email on your booking with {brand.businessName} was just changed.</Paragraph>
      <Paragraph>If this was you, there is nothing to do. If it wasn&apos;t, please contact {brand.businessName} so they can look into it.</Paragraph>
    </EmailLayout>
  );
}

ContactChangedEmail.PreviewProps = {} satisfies ContactChangedEmailProps;
