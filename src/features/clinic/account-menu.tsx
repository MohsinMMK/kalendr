"use client";

import { releasePushForSignOut } from "@/features/app-support/use-push";
import { clearOfflineData } from "@/features/app-support/service-worker";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BellRing, LogOut, Monitor, Moon, Sun, UserRound } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Menu, MenuItem, MenuPopup, MenuPrimitive, MenuRadioGroup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { SidebarMenuButton, useSidebar } from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";

import { clearStaffQueryCache } from "./queries/client";
import { useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { parseTheme, useStaffTheme } from "./theme";
import { practitionerInitials } from "@/lib/clinic-slug";
import { useBusinessProfile } from "@/features/terms/business-profile-context";
import { useNavLabel } from "./sidebar-nav";
import { roleLabelsFor } from "@/lib/permissions";
import type { StaffRole } from "@/server/staff-context";

const themeChoices = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
] as const;

export function AccountMenu({
  userName,
  userEmail,
  role,
  jobTitle = null,
  preview,
  ownPractitionerId = null,
  ownPhotoUrl = null,
}: {
  userName: string;
  userEmail: string;
  role: StaffRole;
  /** What the person is called in the business. Shown under their name instead of the role's name. */
  jobTitle?: string | null;
  preview: boolean;
  ownPractitionerId?: string | null;
  ownPhotoUrl?: string | null;
}) {
  const router = useRouter();
  const { isMobile, state } = useSidebar();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const profile = useBusinessProfile();
  const profileLabel = useNavLabel("profile");
  const theme = useStaffTheme();

  async function signOut() {
    setPending(true);
    setError("");
    try {
      // Forget this device for alerts while the session still works, so the next person here does not get yours.
      await releasePushForSignOut("/api/staff/push/subscribe");
      const result = await authClient.signOut();
      if (result.error) {
        setError("Could not sign out. Try again.");
        return;
      }
      clearStaffQueryCache();
      // The saved offline schedule holds customer details: it goes with the session.
      await clearOfflineData();
      router.replace("/sign-in");
      router.refresh();
    } catch (cause: unknown) {
      console.error("Staff sign-out request failed", cause);
      setError("Could not sign out. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  const initials = practitionerInitials(userName).slice(0, 2);
  // Their own booking profile photo, read from the live catalog so a new photo shows here as soon as it is saved.
  const bookingPhotoUrl = useOptionalStaffSnapshot()?.snapshot?.catalog.practitioners.find((person) => person.id === ownPractitionerId)?.photoUrl ?? null;
  // People without a booking profile use the photo they set on My profile instead.
  const photoUrl = ownPractitionerId ? bookingPhotoUrl : ownPhotoUrl;
  const photo = photoUrl ? <AvatarImage src={photoUrl} alt="" className="object-cover" /> : null;

  return (
    <Menu>
      <MenuTrigger render={<SidebarMenuButton size="lg" />}>
        <Avatar className="size-8 rounded-lg">
          {photo}
          <AvatarFallback className="rounded-lg text-foreground" aria-hidden="true">{initials}</AvatarFallback>
        </Avatar>
        <span className="grid min-w-0 flex-1 text-start text-sm leading-tight">
          <span className="truncate font-medium">{userName}</span>
          <span className="truncate text-xs text-muted-foreground">{preview ? "Preview" : jobTitle ?? roleLabelsFor(profile)[role]}</span>
        </span>
      </MenuTrigger>
      <MenuPopup
        aria-label="Account"
        aria-labelledby={undefined}
        side={!isMobile && state === "collapsed" ? "right" : "top"}
        align="end"
        className="min-w-64"
      >
        <div className="flex items-center gap-2 px-2 py-1.5">
          <Avatar className="size-8 rounded-lg">
            {photo}
            <AvatarFallback className="rounded-lg text-foreground" aria-hidden="true">{initials}</AvatarFallback>
          </Avatar>
          <span className="grid min-w-0 flex-1 text-sm leading-tight">
            <span className="truncate font-medium">{userName}</span>
            <span className="truncate text-xs text-muted-foreground">{userEmail}</span>
          </span>
        </div>
        <MenuSeparator />
        {/* Light, dark or the device's own setting, side by side like tabs. They stay menu radio items, so the arrow keys
            reach them along with the rest of the menu, and choosing one keeps the menu open. */}
        <div className="flex flex-col gap-1.5 px-2 py-1.5">
          <span id="account-appearance" className="text-xs font-medium text-muted-foreground">Appearance</span>
          <SegmentedControl
            size="sm"
            className="w-full"
            render={<MenuRadioGroup aria-labelledby="account-appearance" value={theme.choice} onValueChange={(next) => theme.setChoice(parseTheme(String(next)))} />}
          >
            {themeChoices.map(({ value, label, Icon }) => (
              <SegmentedControlItem key={value} className="flex-1 data-highlighted:outline-ring" render={<MenuPrimitive.RadioItem value={value} closeOnClick={false} />}>
                <Icon aria-hidden="true" />
                {label}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>
        {!preview ? (
          <>
            <MenuSeparator />
            <MenuItem render={<Link href="/profile" />}>
              <UserRound aria-hidden="true" />
              {profileLabel}
            </MenuItem>
            <MenuItem render={<Link href="/profile/notifications" />}>
              <BellRing aria-hidden="true" />
              Notifications
            </MenuItem>
            <MenuSeparator />
            {/* Stays open so a failed sign-out can show its error beside the item. */}
            <MenuItem closeOnClick={false} disabled={pending} onClick={() => void signOut()}>
              <LogOut aria-hidden="true" />
              {pending ? "Signing out…" : "Sign out"}
            </MenuItem>
          </>
        ) : null}
        {error ? <p role="alert" className="px-2 py-1.5 text-sm text-destructive-foreground">{error}</p> : null}
      </MenuPopup>
    </Menu>
  );
}
