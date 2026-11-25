import { kalendrBrand } from "./_shared/brand";
import { EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface SecurityChangeEmailProps {
  name: string;
  /** What changed, as a short sentence fragment such as "An authenticator app was added". */
  change: string;
  when: string;
}

export function subject(): string {
  return "A security setting changed on your Kalendr account";
}

export default function SecurityChangeEmail({ name, change, when }: SecurityChangeEmailProps) {
  return (
    <EmailLayout brand={kalendrBrand} preview="A security setting on your account changed">
      <Title>Security change</Title>
      <Paragraph>Hi {name},</Paragraph>
      <Paragraph>{change} ({when}).</Paragraph>
      <Paragraph>If this wasn&apos;t you, sign in, open Profile, Security and choose &ldquo;Sign out everywhere&rdquo;, then ask your manager to check your account.</Paragraph>
    </EmailLayout>
  );
}

SecurityChangeEmail.PreviewProps = { name: "Asha", change: "An authenticator app was added", when: "19 Nov 2026, 10:42 am" } satisfies SecurityChangeEmailProps;
