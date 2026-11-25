import { kalendrBrand } from "./_shared/brand";
import { ActionButton, EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface MagicLinkEmailProps {
  url: string;
}

export function subject(): string {
  return "Your Kalendr sign-in link";
}

export default function MagicLinkEmail({ url }: MagicLinkEmailProps) {
  return (
    <EmailLayout brand={kalendrBrand} preview="Use this link to sign in">
      <Title>Sign in to Kalendr</Title>
      <Paragraph>Use this link to sign in. It works once and expires in 10 minutes. You can open it on any device.</Paragraph>
      <ActionButton href={url} accent={kalendrBrand.accentColor}>Sign in</ActionButton>
      <Paragraph>If you didn&apos;t ask for this, ignore this email. Nobody can sign in without the link.</Paragraph>
    </EmailLayout>
  );
}

MagicLinkEmail.PreviewProps = { url: "https://kalendr.example/api/auth/magic-link/verify?token=sample" } satisfies MagicLinkEmailProps;
