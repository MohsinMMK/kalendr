import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight, Info } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Frame,
  FrameDescription,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/ui/frame";
import { StaffSignIn } from "@/features/clinic/staff-auth-controls";
import { authIsConfigured, enabledSocialProviders } from "@/lib/auth";
import { isPreviewMode } from "@/server/preview-repository";

export const metadata: Metadata = {
  title: "Staff sign in",
  description: "Sign in to your business workspace.",
  robots: { index: false, follow: false },
};

/**
 * Sign-in is for people who already have an account, so it is one quiet card in the middle
 * of the screen. New businesses go to /start, which has room to explain the product.
 */
export default async function StaffSignInPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const preview = isPreviewMode();
  const { error } = await searchParams;
  const providers = !preview && authIsConfigured ? enabledSocialProviders() : { google: false, microsoft: false };
  const errorCode = Array.isArray(error) ? error[0] : error;
  return (
    <main className="relative isolate flex min-h-dvh flex-1 flex-col overflow-hidden bg-muted/40">
      <a href="#sign-in-form" className="skip-link">Skip to sign in</a>
      {/* A faint dot grid that fades out from the middle, with a soft glow behind the card. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:20px_20px] [mask-image:radial-gradient(ellipse_60%_55%_at_50%_45%,#000_30%,transparent_100%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 -z-10 size-[36rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/8 blur-3xl"
      />

      <header className="flex h-14 shrink-0 items-center justify-between px-4 sm:px-6">
        <Link href="/" className="font-heading text-lg font-semibold text-foreground no-underline">
          kalendr
        </Link>
        <Button variant="ghost" size="sm" render={<Link href="/start" />}>
          Get started
        </Button>
      </header>

      <div className="flex flex-1 items-center justify-center px-4 pt-4 pb-12">
        <Frame className="w-full max-w-[25rem] shadow-lg/5 animate-in fade-in slide-in-from-bottom-3 duration-500 ease-out">
          <FrameHeader className="items-center gap-1 pt-6 text-center">
            <Link href="/" aria-label="Kalendr home" className="mb-3 inline-flex rounded-lg">
              <Image src="/kalendr-mark.svg" alt="" width={40} height={40} loading="eager" />
            </Link>
            <FrameTitle className="font-heading text-xl">
              <h1>Welcome back</h1>
            </FrameTitle>
            <FrameDescription>Sign in to your business workspace.</FrameDescription>
          </FrameHeader>
          <FramePanel id="sign-in-form" tabIndex={-1} className="p-6 outline-none">
            {preview ? (
              <Alert variant="info" role="status">
                <Info aria-hidden="true" />
                <AlertDescription>
                  <p>This development preview has no database or staff accounts configured.</p>
                  <Button variant="outline" className="self-start" render={<Link href="/dashboard" />}>
                    Open preview workspace <ArrowUpRight aria-hidden="true" />
                  </Button>
                </AlertDescription>
              </Alert>
            ) : authIsConfigured ? (
              <StaffSignIn providers={providers} errorCode={errorCode ?? null} />
            ) : (
              <Alert variant="error">
                <AlertDescription>Staff sign-in is not configured. Set up the database and authentication secret before opening this workspace.</AlertDescription>
              </Alert>
            )}
          </FramePanel>
          <FrameFooter className="flex flex-col items-center gap-1 text-center text-sm text-muted-foreground">
            <p>
              New to Kalendr?{" "}
              <Link href="/start" className="font-medium text-foreground underline-offset-4 hover:underline">
                Create your business
              </Link>
            </p>
            <p className="text-xs">Joining a team? Ask your owner or admin for an invite.</p>
          </FrameFooter>
        </Frame>
      </div>
    </main>
  );
}
