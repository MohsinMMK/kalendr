import Image from "next/image";
import { PhoneIcon } from "lucide-react";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import type { ReactNode } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";

import { brandStyle, type BrandSettings } from "@/lib/brand-theme";
import { isClinicalBusinessType } from "@/lib/business-types";
import { defaultBusinessProfile, profileWords, type BusinessProfile } from "@/lib/terminology";

import { BusinessProfileProvider } from "../terms/business-profile-context";
import { phoneHref } from "./booking-format";

/** Two-letter initials for a clinic or practitioner, ignoring honorifics. */
export function getInitials(name: string): string {
  return name
    .replace(/^(dr|mr|mrs|ms)\.?\s+/i, "")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

export function BookingShell({
  clinicName,
  clinicPhone,
  logoUrl,
  embedded = false,
  topBar = true,
  profile,
  brand,
  footerExtra,
  children,
}: {
  clinicName?: string;
  clinicPhone?: string;
  /** The business's own logo; its initials show when there is none. */
  logoUrl?: string | null;
  /** The business's words and features for everything below. Without one the healthcare words are used. */
  profile?: BusinessProfile;
  /** The business's accent colour, corners and badge setting (feature 13). Without one the page keeps Kalendr's own look. */
  brand?: BrandSettings | undefined;
  /** In the website widget, whose Close button sits over this header's top-right corner. */
  embedded?: boolean;
  /** The thin bar with the business name and Call button. Pages that already show the business themselves turn it off. */
  topBar?: boolean;
  /** One more line in the footer, such as the visitor's analytics cookie choice. */
  footerExtra?: ReactNode;
  children: ReactNode;
}) {
  const resolved = profile ?? defaultBusinessProfile;
  const t = profileWords(resolved);
  const clinical = isClinicalBusinessType(resolved.businessType);
  return (
    <BusinessProfileProvider profile={resolved}>
      {/* The layout and time zone of the time screen live in the address (?layout=, ?tz=), so a shared link opens the same view. */}
      <NuqsAdapter>
      {/* overflow-x-clip: a step sliding in never widens the page on a phone. */}
      <div className="group/shell flex min-h-screen flex-col overflow-x-clip bg-background text-foreground" style={brand ? brandStyle(brand) : undefined}>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        {topBar ? (
        <header className="border-b bg-background">
          <div className={`mx-auto flex min-h-14 w-full max-w-6xl items-center justify-between gap-3 px-4 py-2 sm:px-6 lg:px-8 ${embedded ? "pr-22 sm:pr-22 lg:pr-22" : ""}`}>
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {clinicName ? (
                <Avatar className="shrink-0 rounded-lg" aria-hidden="true">
                  {logoUrl ? <AvatarImage src={logoUrl} alt="" className="object-cover" /> : null}
                  <AvatarFallback>{getInitials(clinicName)}</AvatarFallback>
                </Avatar>
              ) : (
                <Image
                  src="/kalendr-mark.svg"
                  width={32}
                  height={32}
                  alt=""
                  priority
                  className="size-8 shrink-0 rounded-lg"
                />
              )}
              <div className="min-w-0">
                <p className="truncate font-heading font-semibold text-sm">
                  {clinicName ?? "Kalendr"}
                </p>
                {clinicName ? (
                  <p className="truncate text-muted-foreground text-xs">Online booking</p>
                ) : null}
              </div>
            </div>
            {clinicPhone ? (
              <Button size="sm" variant="outline" className="shrink-0" render={<a href={phoneHref(clinicPhone)} />}>
                <PhoneIcon aria-hidden="true" />
                {/* In the widget the Close button shares this row, so on a phone the business name keeps the room. */}
                <span className={embedded ? "max-sm:sr-only" : undefined}>Call {t.business}</span>
              </Button>
            ) : null}
          </div>
        </header>
        ) : null}
        {/* Without the bar, the widget's Close button (top-right) still needs clear space above the content. */}
        <main id="main-content" className={`mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-4 sm:px-6 sm:py-8 lg:px-8 ${embedded && !topBar ? "pt-14 sm:pt-14" : ""}`}>
          {children}
        </main>
        {/* Below 1024px the booking bar floats over the bottom of the screen, so the footer ends with room for it. */}
        <footer className="border-t max-lg:group-has-[[data-slot=booking-bar]:not([data-bar-action])]/shell:pb-24 max-lg:group-has-[[data-bar-action]]/shell:pb-44">
          <div className="mx-auto flex w-full max-w-6xl flex-col items-start gap-0.5 px-4 py-4 text-muted-foreground text-xs sm:px-6 lg:px-8">
            <p>{brand?.hideBadge ? null : "Scheduling by Kalendr."}{clinical ? " Kalendr is not an emergency service." : null}</p>
            {clinical ? <p>For urgent or emergency care, contact local emergency services.</p> : null}
            {footerExtra}
          </div>
        </footer>
      </div>
      </NuqsAdapter>
    </BusinessProfileProvider>
  );
}
