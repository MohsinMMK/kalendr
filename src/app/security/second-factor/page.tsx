import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { BusinessPicker } from "@/features/clinic/business-switcher";
import { EnrolSecondFactor } from "@/features/clinic/enrol-second-factor";
import { requireSignedInUser } from "@/server/session-user";
import { otherBusinessesFor } from "@/server/staff-businesses";

export const metadata: Metadata = {
  title: "Set up a second factor",
  description: "Add a second step to your sign-in.",
  robots: { index: false, follow: false },
};

export default async function SecondFactorPage() {
  const user = await requireSignedInUser();
  if (user.twoFactorEnabled || user.passkeyCount > 0) redirect(user.secondFactorAt ? "/dashboard" : "/sign-in/verify");
  // A business that asks for a second factor blocks only itself: someone who works in other businesses can open one of those.
  const otherBusinesses = await otherBusinessesFor(await headers());
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 bg-muted/72 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="justify-items-center gap-2 text-center">
          <Link href="/" aria-label="Kalendr home" className="mb-2 inline-flex rounded-md">
            <Image src="/kalendr-mark.svg" alt="" width={36} height={36} />
          </Link>
          <CardTitle render={<h1 />} className="text-xl">Set up a second factor</CardTitle>
          <CardDescription>Your role can see customer records, so we ask for a second step when you sign in. It takes about two minutes.</CardDescription>
        </CardHeader>
        <CardPanel>
          <EnrolSecondFactor passwordChosen={user.passwordChosen} />
        </CardPanel>
      </Card>
      {otherBusinesses.length > 0 ? <div className="w-full max-w-md"><BusinessPicker businesses={otherBusinesses} /></div> : null}
    </main>
  );
}
