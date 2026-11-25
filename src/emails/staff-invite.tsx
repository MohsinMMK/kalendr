import { DEFAULT_ACCENT, type EmailBrand } from "./_shared/brand";
import { ActionButton, EmailLayout, Paragraph, Title } from "./_shared/layout";

export interface StaffInviteEmailProps {
  name: string;
  inviterName: string;
  brand: Pick<EmailBrand, "businessName" | "logoUrl" | "accentColor">;
  url: string;
  /** The email already has a Kalendr login: they sign in as usual and accept, instead of choosing a password. */
  existingLogin?: boolean;
}

export function subject({ inviterName, brand }: StaffInviteEmailProps): string {
  return `${inviterName} invited you to ${brand.businessName} on Kalendr`;
}

export default function StaffInviteEmail({ name, inviterName, brand, url, existingLogin }: StaffInviteEmailProps) {
  return (
    <EmailLayout brand={brand} preview={`Join ${brand.businessName} on Kalendr`}>
      <Title>{`Join ${brand.businessName}`}</Title>
      <Paragraph>Hi {name},</Paragraph>
      {existingLogin ? (
        <>
          <Paragraph>{`${inviterName} invited you to join ${brand.businessName}. You already have a Kalendr login, so there is no new password: sign in as usual and choose Accept or Decline.`}</Paragraph>
          <ActionButton href={url} accent={brand.accentColor}>Sign in to answer</ActionButton>
          <Paragraph>{`${brand.businessName} can't see your other businesses or use your login until you accept. The invite expires in 7 days. If you weren't expecting it, decline it or ignore this email.`}</Paragraph>
        </>
      ) : (
        <>
          <Paragraph>{`${inviterName} added you to ${brand.businessName}. Choose a password to sign in.`}</Paragraph>
          <ActionButton href={url} accent={brand.accentColor}>Choose a password</ActionButton>
          <Paragraph>This link works once and expires in 7 days. If you weren&apos;t expecting it, ignore this email.</Paragraph>
        </>
      )}
    </EmailLayout>
  );
}

StaffInviteEmail.PreviewProps = {
  name: "Rahul",
  inviterName: "Asha Rao",
  brand: { businessName: "Sunrise Dental Care", logoUrl: null, accentColor: DEFAULT_ACCENT },
  url: "https://kalendr.example/reset-password?token=sample",
} satisfies StaffInviteEmailProps;
