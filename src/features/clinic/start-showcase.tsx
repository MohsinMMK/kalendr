"use client";

import { useSyncExternalStore } from "react";
import { Clock, Globe } from "lucide-react";

import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Skeleton } from "@/components/ui/skeleton";
import { practitionerInitials } from "@/lib/clinic-slug";
import { onboardingTemplates, type OnboardingTemplateId } from "@/lib/onboarding-templates";

/**
 * The right half of /start: the owner's own booking page, drawn from what they have entered so far. Picking a type
 * fills in its services; typing the name shows it at the top. Nothing here is sample data from another business.
 * Hidden below the large breakpoint, where each step stands on its own.
 */
const noSubscribe = () => () => undefined;

export function StartShowcase({
  template,
  businessName,
  ownerName,
  ownerPractices,
  slug,
}: {
  template: OnboardingTemplateId | "";
  businessName: string;
  ownerName: string;
  ownerPractices: boolean;
  slug: string;
}) {
  const host = useSyncExternalStore(noSubscribe, () => window.location.host, () => "kalendr");
  const chosen = template ? onboardingTemplates[template] : null;
  const name = businessName.trim();
  const owner = ownerName.trim();
  const price = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

  return (
    <div className="relative isolate flex h-full flex-col overflow-hidden rounded-3xl border bg-muted/60">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:20px_20px] [mask-image:linear-gradient(to_bottom,#000,transparent_80%)]"
      />
      <div aria-hidden="true" className="pointer-events-none absolute -top-24 -right-24 -z-10 size-96 rounded-full bg-primary/10 blur-3xl" />

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-hidden px-10 py-8">
        <p className="text-xs font-medium text-muted-foreground">Your booking page</p>
        <Frame className="w-full max-w-sm shadow-xl/5">
          <FrameHeader className="flex-row items-center gap-3 py-3">
            <span
              aria-hidden="true"
              className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary font-heading text-sm font-semibold text-primary-foreground transition-colors"
            >
              {name ? practitionerInitials(name) : ""}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {name ? <p className="truncate text-sm font-semibold">{name}</p> : <Skeleton className="h-4 w-36 animate-none" />}
              {chosen ? (
                <p className="truncate text-xs text-muted-foreground">{chosen.label}</p>
              ) : (
                <Skeleton className="h-3 w-20 animate-none" />
              )}
            </div>
          </FrameHeader>
          <FramePanel className="flex flex-col gap-2 p-3">
            {chosen
              ? chosen.services.slice(0, 4).map((service, index) => (
                  <div
                    key={`${template}-${service.name}`}
                    style={{ animationDelay: `${index * 60}ms` }}
                    className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 fill-mode-both animate-in fade-in slide-in-from-bottom-1 duration-300"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{service.name}</p>
                      <p className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="size-3" aria-hidden="true" />
                        {service.durationMinutes} min
                        {ownerPractices && owner ? <span className="truncate"> · with {owner.split(/\s+/)[0]}</span> : null}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                      {service.priceRupees ? price.format(service.priceRupees) : "Free"}
                    </span>
                  </div>
                ))
              : [0, 1, 2].map((index) => (
                  <div key={index} className="flex items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-3">
                    <div className="flex flex-col gap-1.5">
                      <Skeleton className="h-3.5 w-28 animate-none" />
                      <Skeleton className="h-3 w-14 animate-none" />
                    </div>
                    <Skeleton className="h-3.5 w-10 animate-none" />
                  </div>
                ))}
          </FramePanel>
          <FrameFooter className="flex items-center gap-2 py-2.5 text-xs text-muted-foreground">
            <Globe className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {host}/book/<span className="font-medium text-foreground">{slug || "your-business"}</span>
            </span>
          </FrameFooter>
        </Frame>
      </div>
    </div>
  );
}
