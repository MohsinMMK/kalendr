import { kalendrBrand } from "./_shared/brand";
import { ActionButton, EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface PasswordResetEmailProps {
  name: string;
  url: string;
}

export function subject(): string {
  return "Reset your Kalendr password";
}

export default function PasswordResetEmail({ name, url }: PasswordResetEmailProps) {
  return (
    <EmailLayout brand={kalendrBrand} preview="Choose a new password">
      <Title>Reset your password</Title>
      <Paragraph>Hi {name},</Paragraph>
      <Paragraph>Use this link to choose a new password. It works once and expires in 1 hour.</Paragraph>
      <ActionButton href={url} accent={kalendrBrand.accentColor}>Choose a new password</ActionButton>
      <Paragraph>If you didn&apos;t ask for this, ignore this email; your password stays the same.</Paragraph>
    </EmailLayout>
  );
}

PasswordResetEmail.PreviewProps = { name: "Asha", url: "https://kalendr.example/reset-password?token=sample" } satisfies PasswordResetEmailProps;
