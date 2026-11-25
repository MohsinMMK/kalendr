import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

import { isClinicalBusinessType } from "@/lib/business-types";
import type { BusinessProfile } from "@/lib/terminology";

import { BusinessProfileProvider, useBusinessProfile, useTerms } from "../terms/business-profile-context";

/** The patient side of Kalendr: one header and footer for the portal, whichever clinic a visit belongs to. */
export function PortalShell({ contact, actions, profile, children }: {
  contact?: string;
  actions?: ReactNode;
  /** The words of the businesses this person books with. Before sign-in there are none, so the healthcare words stay. */
  profile?: BusinessProfile;
  children: ReactNode;
}) {
  return (
    <BusinessProfileProvider profile={profile}>
      <div className="flex min-h-screen flex-col bg-background text-foreground">
        <a className="skip-link" href="#main-content">Skip to main content</a>
        <header className="border-b bg-background">
          <div className="mx-auto flex min-h-14 w-full max-w-4xl items-center justify-between gap-3 px-4 sm:px-6">
            <Link href="/portal" className="flex min-w-0 items-center gap-3">
              <Image src="/kalendr-mark.svg" width={32} height={32} alt="" priority className="size-8 rounded-lg" />
              <div className="min-w-0">
                <PortalName />
                {contact ? <p className="truncate text-xs text-muted-foreground">Signed in as {contact}</p> : null}
              </div>
            </Link>
            {actions}
          </div>
        </header>
        <main id="main-content" className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-4 sm:px-6 sm:py-8">
          {children}
        </main>
        <PortalFooter />
      </div>
    </BusinessProfileProvider>
  );
}

function PortalName() {
  const t = useTerms();
  return <p className="truncate font-heading text-sm font-semibold">{t.Customer} portal</p>;
}

function PortalFooter() {
  const clinical = isClinicalBusinessType(useBusinessProfile().businessType);
  return (
    <footer className="border-t">
      <p className="mx-auto w-full max-w-4xl px-4 py-4 text-xs text-muted-foreground sm:px-6">
        {clinical
          ? "For an emergency, call your local emergency number or go to the nearest hospital. This portal isn't monitored for urgent messages."
          : "This portal isn't monitored for urgent messages."}
      </p>
    </footer>
  );
}
