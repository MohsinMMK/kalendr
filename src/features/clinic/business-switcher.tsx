"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronsUpDown, LayoutDashboard, Stethoscope, Store } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { SidebarMenuButton, useSidebar } from "@/components/ui/sidebar";
import { clearOfflineData } from "@/features/app-support/service-worker";
import { useBusinessProfile } from "@/features/terms/business-profile-context";
import type { OwnBusiness } from "@/lib/active-business";
import { practitionerInitials } from "@/lib/clinic-slug";
import { roleLabelsFor } from "@/lib/permissions";

import { clearStaffQueryCache } from "./queries/client";
import { staffMutation } from "./queries/http";

/**
 * Opens another business the same login works in. What the page holds (the schedule, customers, searches) belongs to the
 * business being left, so it is cleared the way a sign-out clears it, and the page is loaded again from the server rather
 * than patched in place.
 */
export function useSwitchBusiness(): { pending: boolean; error: string; switchTo: (slug: string) => Promise<void> } {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function switchTo(slug: string) {
    setPending(true);
    setError("");
    try {
      await staffMutation<{ slug: string }>("/api/staff/business/switch", "POST", { slug });
      clearStaffQueryCache();
      await clearOfflineData();
      // A full page load, not a client navigation: the router keeps the pages it has seen, and those belong to the business being left.
      window.location.assign(new URL("/dashboard", window.location.origin));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Could not switch. Try again.");
      setPending(false);
    }
  }
  return { pending, error, switchTo };
}

function BusinessMark({ name, logoUrl, clinical, current }: { name: string; logoUrl?: string | null; clinical: boolean; current: boolean }) {
  if (current && logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a small saved picture, already resized on upload
      <img src={logoUrl} alt="" className="aspect-square size-8 shrink-0 rounded-lg bg-sidebar-accent object-cover" />
    );
  }
  if (current) {
    return (
      <span className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
        {clinical ? <Stethoscope aria-hidden="true" /> : <Store aria-hidden="true" />}
      </span>
    );
  }
  // Another business's logo is not readable from here (each business's data is private to it), so its first letters stand in.
  return (
    <Avatar className="size-8 rounded-lg">
      <AvatarFallback className="rounded-lg text-xs text-foreground" aria-hidden="true">{practitionerInitials(name).slice(0, 2)}</AvatarFallback>
    </Avatar>
  );
}

/**
 * A role's name in a business other than the open one. That business has its own words (a stylist, a doctor) that are not
 * readable from here, so its roles are named neutrally rather than in the open business's words.
 */
function otherRoleLabel(role: OwnBusiness["role"], own: Record<OwnBusiness["role"], string>): string {
  return role === "practitioner" ? "Practitioner" : own[role];
}

/** The business row at the top of the sidebar for a person who works in two or more businesses. */
export function BusinessSwitcher({ businesses, logoUrl, clinical, subtitle, onNavigate }: {
  businesses: OwnBusiness[];
  logoUrl: string | null;
  clinical: boolean;
  /** The line under the name, the same one the plain row shows. */
  subtitle?: string;
  onNavigate: () => void;
}) {
  const { isMobile, state } = useSidebar();
  const profile = useBusinessProfile();
  const roleLabels = roleLabelsFor(profile);
  const { pending, error, switchTo } = useSwitchBusiness();
  const current = businesses.find((business) => business.current) ?? businesses[0];
  if (!current) return null;
  return (
    <Menu>
      <MenuTrigger render={<SidebarMenuButton size="lg" tooltip={current.name} className="group-has-data-[sidebar=menu-action]/menu-item:pe-10" />}>
        <BusinessMark name={current.name} logoUrl={logoUrl} clinical={clinical} current />
        <span className="grid min-w-0 flex-1 text-start text-sm leading-tight">
          <span className="truncate font-medium">{current.name}</span>
          <span className="truncate text-xs text-muted-foreground">{subtitle ?? roleLabels[current.role]}</span>
        </span>
        <ChevronsUpDown aria-hidden="true" className="ms-auto text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup aria-label="Businesses" aria-labelledby={undefined} side={isMobile || state === "expanded" ? "bottom" : "right"} align="start" className="min-w-72">
        <MenuGroup>
          <MenuGroupLabel>Your businesses</MenuGroupLabel>
          <MenuRadioGroup value={current.slug} onValueChange={(next) => { if (next !== current.slug) void switchTo(String(next)); }}>
            {businesses.map((business) => (
              <MenuRadioItem key={business.slug} value={business.slug} disabled={pending} className="py-1.5">
                <span className="flex min-w-0 items-center gap-2">
                  <BusinessMark name={business.name} logoUrl={logoUrl} clinical={clinical} current={business.current} />
                  <span className="grid min-w-0 leading-tight">
                    <span className="truncate font-medium">{business.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{business.current ? roleLabels[business.role] : otherRoleLabel(business.role, roleLabels)}</span>
                  </span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem render={<Link href="/dashboard" />} onClick={onNavigate}>
          <LayoutDashboard aria-hidden="true" />
          Dashboard
        </MenuItem>
        {error ? <p role="alert" className="px-2 py-1.5 text-sm text-destructive-foreground">{error}</p> : null}
      </MenuPopup>
    </Menu>
  );
}

/**
 * A plain list of the other businesses, for the screens that can leave someone stuck in one (a business that asks for a
 * second factor they have not set up, a missing profile). Always in the page, so it needs no menu.
 */
export function BusinessPicker({ businesses }: { businesses: OwnBusiness[] }) {
  const profile = useBusinessProfile();
  const roleLabels = roleLabelsFor(profile);
  const { pending, error, switchTo } = useSwitchBusiness();
  if (businesses.length === 0) return null;
  return (
    <div className="flex w-full flex-col gap-2">
      <p className="text-sm font-medium">Open another business</p>
      {error ? <Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <ul className="flex flex-col gap-2">
        {businesses.map((business) => (
          <li key={business.slug}>
            <Button variant="outline" className="h-auto w-full justify-start gap-3 py-2 text-start" disabled={pending} onClick={() => void switchTo(business.slug)}>
              <BusinessMark name={business.name} clinical={false} current={false} />
              <span className="grid min-w-0 leading-tight">
                <span className="truncate font-medium">{business.name}</span>
                <span className="truncate text-xs font-normal text-muted-foreground">{otherRoleLabel(business.role, roleLabels)}</span>
              </span>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
