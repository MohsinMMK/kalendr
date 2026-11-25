import { Text } from "react-email";

import { kalendrBrand, type EmailBrand } from "./_shared/brand";
import { EmailLayout, Paragraph, styles, Title } from "./_shared/layout";

export interface BookingCodeEmailProps {
  code: string;
  brand?: Pick<EmailBrand, "businessName" | "logoUrl" | "accentColor">;
}

export function subject({ code }: BookingCodeEmailProps): string {
  return `${code} is your booking code`;
}

export default function BookingCodeEmail({ code, brand = kalendrBrand }: BookingCodeEmailProps) {
  return (
    <EmailLayout brand={brand} preview={`Your booking code is ${code}`}>
      <Title>Confirm your email address</Title>
      <Paragraph>Enter this code on the booking page to finish booking with {brand.businessName}. It works for 10 minutes.</Paragraph>
      <Text style={styles.code}>{code}</Text>
      <Paragraph>If you didn&apos;t ask for it, you can ignore this email. Nothing is booked without the code.</Paragraph>
    </EmailLayout>
  );
}

BookingCodeEmail.PreviewProps = { code: "482913" } satisfies BookingCodeEmailProps;
