import { Text } from "react-email";

import { kalendrBrand, type EmailBrand } from "./_shared/brand";
import { EmailLayout, Paragraph, styles, Title } from "./_shared/layout";

export interface SignInCodeEmailProps {
  code: string;
  /** The business the customer is signing in to see, when it is known. */
  brand?: Pick<EmailBrand, "businessName" | "logoUrl" | "accentColor">;
  /** "booking_change": the code that lets someone with a manage link cancel, move or change a booking. */
  /** "sign_up": the code that confirms a new owner's email before their business is created. */
  purpose?: "sign_in" | "booking_change" | "sign_up";
}

export function subject({ code, purpose }: SignInCodeEmailProps): string {
  if (purpose === "sign_up") return `${code} is your Kalendr code`;
  return purpose === "booking_change" ? `${code} is your verification code` : `${code} is your sign-in code`;
}

export default function SignInCodeEmail({ code, brand = kalendrBrand, purpose = "sign_in" }: SignInCodeEmailProps) {
  return (
    <EmailLayout brand={brand} preview={`Your sign-in code is ${code}`}>
      <Title>{purpose === "sign_up" ? "Confirm your email" : purpose === "booking_change" ? "Your verification code" : "Your sign-in code"}</Title>
      <Paragraph>{purpose === "sign_up" ? "Enter this code to create your Kalendr account." : purpose === "booking_change" ? "Enter this code to change your booking." : "Enter this code to see your bookings."} It works for 10 minutes.</Paragraph>
      <Text style={styles.code}>{code}</Text>
      <Paragraph>If you didn&apos;t ask for it, you can ignore this email. Nobody can sign in without the code.</Paragraph>
    </EmailLayout>
  );
}

SignInCodeEmail.PreviewProps = { code: "482913" } satisfies SignInCodeEmailProps;
