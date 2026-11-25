import type { Metadata } from "next";
import Link from "next/link";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/ui/frame";
import { StartClinicForm } from "@/features/clinic/start-clinic-form";
import { enabledSocialProviders } from "@/lib/auth";
import { isClinicRegistrationOpen } from "@/server/clinic-registration";
import { isPreviewMode } from "@/server/preview-repository";
import { turnstileSiteKey } from "@/server/turnstile";

// Registration and preview gates belong to the running deployment.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Start taking bookings",
  description: "Create a Kalendr booking page and the first owner account.",
  robots: { index: false, follow: false },
};

export default async function StartClinicPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const { error } = await searchParams;
  const preview = isPreviewMode();
  const open = isClinicRegistrationOpen();
  if (preview) {
    return <StartClinicForm preview />;
  }
  if (!open) {
    return (
      <main className="grid min-h-dvh place-items-center bg-background px-4 py-10">
        <section className="flex w-full max-w-md flex-col gap-6">
          <Link href="/" className="font-heading text-lg font-semibold text-foreground no-underline">kalendr</Link>
          <Frame>
            <FrameHeader>
              <h1 className="font-heading text-xl font-semibold">Start taking bookings</h1>
            </FrameHeader>
            <FramePanel>
              <Alert variant="warning">
                <AlertDescription>Sign-up is not open on this deployment.</AlertDescription>
              </Alert>
            </FramePanel>
            <FrameFooter className="flex justify-end">
              <Button render={<Link href="/sign-in" />}>Sign in</Button>
            </FrameFooter>
          </Frame>
        </section>
      </main>
    );
  }
  const { google, microsoft } = enabledSocialProviders();
  return <StartClinicForm turnstileSiteKey={turnstileSiteKey()} providers={{ google, microsoft }} initialError={(Array.isArray(error) ? error[0] : error) ?? null} />;
}
