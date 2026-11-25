import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { cache } from "react";
import { CircleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { ResetPasswordForm } from "@/features/clinic/password-forms";
import { findPasswordLink } from "@/server/password-links";
import { findLoginInviteLink } from "@/server/staff-login-invites";

type SearchParams = Promise<{ token?: string | string[]; invite?: string | string[]; error?: string | string[] }>;

/** The link is looked up once per request and shared by the page and its title. */
const findLink = cache(async (token: string) => (token ? findPasswordLink(token) : null));
/**
 * An invite to someone who already has a login (`staff-login-invites.ts`) arrives at this same address, so an invite link
 * looks the same whatever the email. It sets no password: the person signs in as usual and accepts there.
 */
const findJoinLink = cache(async (token: string) => (/^[A-Za-z0-9_-]{16,128}$/.test(token) ? findLoginInviteLink(token).catch(() => null) : null));

async function lookUpLink(params: Awaited<SearchParams>) {
  const token = typeof params.token === "string" ? params.token : "";
  const person = params.error ? null : await findLink(token);
  const join = person || params.error || params.invite !== "1" ? null : await findJoinLink(token);
  return { token, person, join, invite: Boolean(person && (params.invite === "1" || !person.hasPassword)) };
}

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const { person, join, invite } = await lookUpLink(await searchParams);
  return {
    title: join ? "You're invited" : !person ? "Link expired" : invite ? "Choose your password" : "Choose a new password",
    description: "Set the password for your Kalendr account.",
    robots: { index: false, follow: false },
    // The token is in this page's URL; never pass it on to another site.
    referrer: "no-referrer",
  };
}

export default async function ResetPasswordPage({ searchParams }: { searchParams: SearchParams }) {
  const { token, person, join, invite } = await lookUpLink(await searchParams);
  if (join) return <JoinInvite businessName={join.businessName} />;
  // "Dr Mohammed Khaleed" is greeted as Mohammed, not "Dr".
  const firstName = person?.name.split(/\s+/).find((word) => !/^(dr|dra|prof|mr|mrs|ms|mx)\.?$/i.test(word)) ?? person?.name ?? "";

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 bg-muted/72 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="justify-items-center gap-2 text-center">
          <Link href="/" aria-label="Kalendr home" className="mb-2 inline-flex rounded-md">
            <Image src="/kalendr-mark.svg" alt="" width={36} height={36} />
          </Link>
          <CardTitle render={<h1 />} className="text-xl">
            {!person ? "This link has expired" : invite ? `Welcome, ${firstName}.` : "Choose a new password"}
          </CardTitle>
          <CardDescription>
            {!person
              ? "Password links work once, for a limited time."
              : invite
                ? <>Choose a password to finish setting up your account for <span className="font-medium text-foreground">{person.email}</span>.</>
                : <>For <span className="font-medium text-foreground">{person.email}</span>. You&apos;ll be signed out on every other device.</>}
          </CardDescription>
        </CardHeader>
        <CardPanel>
          {person ? (
            <ResetPasswordForm token={token} email={person.email} invite={invite} />
          ) : (
            <div className="flex flex-col gap-4">
              <Alert variant="warning">
                <CircleAlert aria-hidden="true" />
                <AlertTitle>We can&apos;t use this link</AlertTitle>
                <AlertDescription>
                  It has already been used, it has expired, or it was copied incompletely. If you were invited, ask the owner or an admin to send a new invite from the Team page (Sign-in and access).
                </AlertDescription>
              </Alert>
              <Button size="lg" className="w-full" render={<Link href="/forgot-password" />}>Send me a new link</Button>
            </div>
          )}
        </CardPanel>
        <CardFooter className="justify-center text-xs text-muted-foreground">
          <p>
            Already have a password?{" "}
            <Button variant="link" size="xs" className="px-0.5" render={<Link href="/sign-in" />}>Sign in</Button>
          </p>
        </CardFooter>
      </Card>
      <p className="text-center text-xs text-muted-foreground">For business teams · Appointments, organized with care.</p>
    </main>
  );
}

/** The page an invite to an existing login opens: sign in as usual, then accept or decline where the invite is shown. */
function JoinInvite({ businessName }: { businessName: string }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 bg-muted/72 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="justify-items-center gap-2 text-center">
          <Link href="/" aria-label="Kalendr home" className="mb-2 inline-flex rounded-md">
            <Image src="/kalendr-mark.svg" alt="" width={36} height={36} />
          </Link>
          <CardTitle render={<h1 />} className="text-xl">You&apos;re invited to join {businessName}</CardTitle>
          <CardDescription>
            You already have a Kalendr login, so there is no new password to choose. Sign in as usual, then accept or decline the invite.
          </CardDescription>
        </CardHeader>
        <CardPanel>
          <Button size="lg" className="w-full" render={<Link href="/sign-in" />}>Sign in</Button>
        </CardPanel>
        <CardFooter className="justify-center text-center text-xs text-muted-foreground">
          <p>Nothing changes until you accept. If you decline, {businessName} is not told.</p>
        </CardFooter>
      </Card>
      <p className="text-center text-xs text-muted-foreground">For business teams · Appointments, organized with care.</p>
    </main>
  );
}
