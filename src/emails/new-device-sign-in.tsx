import { kalendrBrand } from "./_shared/brand";
import { EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface NewDeviceSignInEmailProps {
  name: string;
  /** A short device description such as "Chrome on macOS". */
  device: string;
  /** When it happened, already formatted for the reader. */
  when: string;
}

export function subject(): string {
  return "New sign-in to your Kalendr account";
}

export default function NewDeviceSignInEmail({ name, device, when }: NewDeviceSignInEmailProps) {
  return (
    <EmailLayout brand={kalendrBrand} preview="Someone signed in from a new device">
      <Title>New sign-in</Title>
      <Paragraph>Hi {name},</Paragraph>
      <Paragraph>Your account was signed in from a device we haven&apos;t seen before: {device}, {when}.</Paragraph>
      <Paragraph>If this was you, there&apos;s nothing to do. If it wasn&apos;t, sign in, open Profile, Security and choose &ldquo;Sign out everywhere&rdquo;, then change your password.</Paragraph>
    </EmailLayout>
  );
}

NewDeviceSignInEmail.PreviewProps = { name: "Asha", device: "Chrome on macOS", when: "19 Nov 2026, 10:42 am" } satisfies NewDeviceSignInEmailProps;
