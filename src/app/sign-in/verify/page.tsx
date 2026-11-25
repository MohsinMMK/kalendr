import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { VerifySecondFactor } from "@/features/clinic/verify-second-factor";
import { requireSignedInUser } from "@/server/session-user";

export const metadata: Metadata = {
  title: "Confirm it's you",
  description: "Enter a code or use a passkey to finish signing in.",
  robots: { index: false, follow: false },
};

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const user = await requireSignedInUser();
  const { next } = await searchParams;
  const destination = (Array.isArray(next) ? next[0] : next) === "/setup" ? "/setup" : "/dashboard";
  if (!user.twoFactorEnabled && user.passkeyCount === 0) redirect("/security/second-factor");
  if (user.secondFactorAt) redirect(destination);
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 bg-muted/72 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="justify-items-center gap-2 text-center">
          <Link href="/" aria-label="Kalendr home" className="mb-2 inline-flex rounded-md">
            <Image src="/kalendr-mark.svg" alt="" width={36} height={36} />
          </Link>
          <CardTitle render={<h1 />} className="text-xl">Confirm it&apos;s you</CardTitle>
          <CardDescription>One more step to finish signing in as {user.email}.</CardDescription>
        </CardHeader>
        <CardPanel>
          <VerifySecondFactor hasAuthenticator={user.twoFactorEnabled} hasPasskey={user.passkeyCount > 0} destination={destination} />
        </CardPanel>
      </Card>
    </main>
  );
}
