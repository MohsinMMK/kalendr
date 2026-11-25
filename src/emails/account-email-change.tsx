import { kalendrBrand } from "./_shared/brand";
import { ActionButton, EmailLayout, Paragraph, Title } from "./_shared/layout";

export type AccountEmailChangeKind = "confirm" | "requested" | "changed" | "changed_by_admin" | "now_yours" | "added_to_business";

export interface AccountEmailChangeEmailProps {
  kind: AccountEmailChangeKind;
  name: string;
  /** The business, for "ask your manager at …". */
  business?: string;
  when?: string;
  /** Only for `confirm`: the one-time link that makes the new address the sign-in email. */
  url?: string;
}

const subjects: Record<AccountEmailChangeKind, string> = {
  confirm: "Confirm your new Kalendr sign-in email",
  requested: "Someone asked to change your Kalendr sign-in email",
  changed: "Your Kalendr sign-in email was changed",
  changed_by_admin: "Your Kalendr sign-in email was changed by your manager",
  now_yours: "This is now your Kalendr sign-in email",
  added_to_business: "You've been added to a business on Kalendr",
};

export function subject({ kind, business }: AccountEmailChangeEmailProps): string {
  return kind === "added_to_business" ? `You've been added to ${business ?? "a business"} on Kalendr` : subjects[kind];
}

/**
 * Account emails about a changed sign-in address. None of them names the other address: the old one is told that it changed
 * (so a stolen account is noticed), the new one is told where to go, and the link in `confirm` is the only thing that moves it.
 */
export default function AccountEmailChangeEmail({ kind, name, business, when, url }: AccountEmailChangeEmailProps) {
  const manager = business ? `your manager at ${business}` : "your manager";
  const at = when ? ` (${when})` : "";
  return (
    <EmailLayout brand={kalendrBrand} preview={subject({ kind, name, business })}>
      <Title>{kind === "confirm" ? "Confirm your new email" : kind === "now_yours" ? "Your sign-in email" : kind === "added_to_business" ? "You've been added" : "Sign-in email change"}</Title>
      <Paragraph>Hi {name},</Paragraph>
      {kind === "confirm" ? (
        <>
          <Paragraph>You asked to use this address to sign in to Kalendr. Open the link to confirm it. The link works for one hour.</Paragraph>
          {url ? <ActionButton href={url} accent={kalendrBrand.accentColor}>Confirm this email</ActionButton> : null}
          <Paragraph>If you did not ask for this, ignore this email. Nothing changes until you open the link.</Paragraph>
        </>
      ) : null}
      {kind === "requested" ? (
        <>
          <Paragraph>Someone asked to change the sign-in email on your Kalendr account{at}. Nothing has changed yet: the change only happens if the link sent to the new address is opened.</Paragraph>
          <Paragraph>If this was you, there is nothing to do. If it was not, sign in, open Profile, Security and choose &ldquo;Sign out everywhere&rdquo;, then tell {manager}.</Paragraph>
        </>
      ) : null}
      {kind === "changed" ? (
        <>
          <Paragraph>The sign-in email on your Kalendr account was changed{at}. This address no longer signs in to it, and your other devices were signed out.</Paragraph>
          <Paragraph>If this was not you, tell {manager} right away so they can check the account.</Paragraph>
        </>
      ) : null}
      {kind === "changed_by_admin" ? (
        <>
          <Paragraph>{business ?? "Your manager"} changed the sign-in email on your Kalendr account{at}. This address no longer signs in to it, and you were signed out on every device.</Paragraph>
          <Paragraph>If you did not expect this, tell {manager}.</Paragraph>
        </>
      ) : null}
      {kind === "added_to_business" ? (
        <>
          <Paragraph>{business ?? "A business"} added you to its team on Kalendr{at}. You use the same email and password you already have: there is nothing new to set up.</Paragraph>
          <Paragraph>Sign in as usual and choose {business ?? "the business"} from the business menu at the top of the sidebar.</Paragraph>
          <Paragraph>If you did not expect this, tell {manager}, or open your profile and choose &ldquo;Sign out everywhere&rdquo;.</Paragraph>
        </>
      ) : null}
      {kind === "now_yours" ? (
        <>
          <Paragraph>{business ?? "Your manager"} set this address as the sign-in email for your Kalendr account{at}.</Paragraph>
          <Paragraph>Sign in with your password. We will ask you to confirm this address the first time. If you have not chosen a password yet, use the invite email sent to this address.</Paragraph>
          <Paragraph>If you did not expect this, tell {manager}.</Paragraph>
        </>
      ) : null}
    </EmailLayout>
  );
}

AccountEmailChangeEmail.PreviewProps = {
  kind: "changed",
  name: "Asha",
  business: "Sample Clinic",
  when: "25 Nov 2026, 10:42 am",
} satisfies AccountEmailChangeEmailProps;
