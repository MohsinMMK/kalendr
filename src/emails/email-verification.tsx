import { kalendrBrand } from "./_shared/brand";
import { ActionButton, EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface EmailVerificationEmailProps {
  url: string;
}

export function subject(): string {
  return "Verify your Kalendr owner account";
}

export default function EmailVerificationEmail({ url }: EmailVerificationEmailProps) {
  return (
    <EmailLayout brand={kalendrBrand} preview="Verify your email to finish setting up">
      <Title>Verify your email</Title>
      <Paragraph>Verify your email to finish setting up your business.</Paragraph>
      <ActionButton href={url} accent={kalendrBrand.accentColor}>Verify email</ActionButton>
      <Paragraph>If you did not create this account, ignore this email.</Paragraph>
    </EmailLayout>
  );
}

EmailVerificationEmail.PreviewProps = { url: "https://kalendr.example/api/auth/verify-email?token=sample" } satisfies EmailVerificationEmailProps;
