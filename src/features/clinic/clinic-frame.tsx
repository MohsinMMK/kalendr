"use client";

import type { DehydratedState } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  CalendarDays,
  LayoutDashboard,
  MessagesSquare,
  Plus,
  Search,
  Settings,
  Stethoscope,
  UsersRound,
  Store,
  Ellipsis,
  PanelLeft,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { NuqsAdapter } from "nuqs/adapters/next/app";

import { BookingLinkPin } from "./booking-link-pin";

import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { HookSidebar } from "@/components/ui/hook-sidebar";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Separator } from "@/components/ui/separator";
import { ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { isClinicalBusinessType } from "@/lib/business-types";
import { demoAppointments } from "@/lib/demo-data";
import { emptyWorkspaceLayout, type WorkspaceLayout } from "@/lib/workspace-layout";
import { cn } from "@/lib/utils";
import type { OwnBusiness } from "@/lib/active-business";
import type { Permission, StaffRole } from "@/lib/permissions";
import type { ImpersonationBanner as ImpersonationFacts } from "@/lib/admin-contracts";

import { useBusinessProfile, useTerms } from "../terms/business-profile-context";
import { AccountMenu } from "./account-menu";
import { PendingInvites } from "./pending-invites";
import { BusinessSwitcher } from "./business-switcher";
import { CustomizeSidebarDrawer } from "./customize-sidebar";
import { entryActions, useEntryAvailable, useNavLabel, useNavLabels, useNavSections, useSidebarSettings, type NavItem } from "./sidebar-nav";
import { isBoundedPath, useActiveRoute, type ClinicRoute } from "./active-route";
import { ImpersonationBanner } from "./impersonation-banner";
import { BillingBanners } from "@/features/billing/billing-banners";
import type { MyInvite } from "@/server/staff-login-invites";
import { onBillingRequest } from "@/features/billing/billing-navigation";
import { onCustomizeSidebarRequest, onSettingsRequest, requestCustomizeSidebar, takeSettingsRequest } from "./settings-navigation";
import { UpgradePromptProvider } from "@/features/billing/upgrade-prompt";
import { NotificationBell } from "./notification-bell";
import { AppSupport } from "@/features/app-support/app-support";
import { OfflineBanner } from "@/features/app-support/offline-banner";
import { actionItems, dayVisits } from "./clinic-today";
import { CopilotPanel } from "./assistant/copilot-panel";
import { NewVisitProvider, useNewVisit } from "./new-visit-sheet";
import { StaffQueryProvider } from "./queries/client";
import { type ViewportGuess, ViewportGuessProvider } from "./staff-viewport";
import { ShortcutsProvider } from "./shortcuts";
import { StepUpProvider } from "./step-up-dialog";
import { StaffThemeProvider, type ThemeChoice, useStaffTheme } from "./theme";
import { clinicDateKey, usePreviewAppointments } from "./preview-appointments";
import { pickSettingsSection, settingsHref, useSettingsSections } from "./settings-sections";
import { SettingsSidebar } from "./settings-sidebar";
import { StaffAccessProvider } from "./staff-access";
import { StaffBusinessProfile } from "./staff-business-profile";
import { WorkspaceLayoutProvider } from "./workspace-layout-provider";
import { StaffSnapshotProvider, useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { useVisitsNeedingPerson } from "./use-visits-needing-person";
import { WorkspaceStatus } from "./workspace-status";

// Opened by a click or a shortcut, so their code loads the first time they are needed, not with every page.
const ClinicCommand = dynamic(() => import("./clinic-command").then((m) => m.ClinicCommand));
const HelpDialog = dynamic(() => import("./help-dialog").then((m) => m.HelpDialog));
// Starts itself or waits for a request; it never shows on first paint, so it loads after the page.
const ProductTour = dynamic(() => import("./product-tour").then((m) => m.ProductTour), { ssr: false });

export type { ClinicRoute };

const emptySubscribe = () => () => {};

function useShortcutModifier(): string {
  return useSyncExternalStore(
    emptySubscribe,
    () => (/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl "),
    () => "⌘",
  );
}

function useNeedsActionCount(): number | null {
  const staff = useOptionalStaffSnapshot();
  const { appointments, patients, operations, database } = usePreviewAppointments();
  if (staff && !staff.snapshot) return null;
  const dayKey = database ? clinicDateKey(operations.clockIso) : clinicDateKey(demoAppointments[0].startsAt);
  return actionItems(dayVisits(appointments, dayKey), patients, operations.visitTimings, operations.clockIso).length;
}

/** The nav item to highlight. A page that is a task rather than a place, like booking, highlights none. */
function useHighlightedRoute(): ClinicRoute | null {
  const route = useActiveRoute();
  return usePathname() === "/appointments/new" ? null : route;
}

/** One sidebar entry: a page link, or a button for the panels (Settings, Help). Its id lets the tour find it whatever it is called. */
function NavEntryButton({ item, href, active, onNavigate, onAction }: {
  item: NavItem;
  href: string | undefined;
  active: boolean;
  onNavigate: () => void;
  onAction: (() => void) | null;
}) {
  const content = (
    <>
      <item.icon aria-hidden="true" />
      <span>{item.label}</span>
    </>
  );
  if (!href) {
    return (
      <SidebarMenuButton data-nav-id={item.id} tooltip={item.label} onClick={() => { onNavigate(); onAction?.(); }}>
        {content}
      </SidebarMenuButton>
    );
  }
  return (
    <SidebarMenuButton data-nav-id={item.id} isActive={active} tooltip={item.label} onClick={onNavigate} render={<Link href={href} aria-current={active ? "page" : undefined} />}>
      {content}
    </SidebarMenuButton>
  );
}

/** An icon button at the right end of a sidebar row (Search beside the business name, Settings beside the account). */
function RowIconAction({ label, hint, navId, onClick, children }: {
  label: string;
  /** A shortcut shown in the tooltip, not read out. */
  hint?: string;
  navId?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const { isMobile } = useSidebar();
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuAction
              data-nav-id={navId}
              aria-label={label}
              onClick={onClick}
              className="top-1/2! size-7 w-7 -translate-y-1/2 text-muted-foreground hover:text-sidebar-accent-foreground"
            />
          }
        >
          {children}
        </TooltipTrigger>
        <TooltipPopup side={isMobile ? "bottom" : "right"}>
          {label}
          {hint ? <span className="ms-1.5 text-muted-foreground" aria-hidden="true">{hint}</span> : null}
        </TooltipPopup>
      </Tooltip>
    </TooltipProvider>
  );
}

function ClinicSidebar({ clinicName, clinicSlug, userName, userEmail, role, jobTitle, preview, ownPractitionerId, ownPhotoUrl, businesses, onOpenSettings, onOpenHelp, onSearch }: {
  /** Every business this login works in. The switcher replaces the plain business row only when there are two or more. */
  businesses: OwnBusiness[];
  jobTitle: string | null;
  ownPractitionerId: string | null;
  ownPhotoUrl: string | null;
  clinicName: string;
  clinicSlug: string;
  userName: string;
  userEmail: string;
  role: StaffRole;
  preview: boolean;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  onSearch: () => void;
}) {
  const { setOpenMobile, state, isMobile } = useSidebar();
  // Open, the sidebar draws each section as a list with a rail that marks the page you are on. Folded to icons, it keeps
  // the icon buttons with their tooltips, since a rail beside a column of icons has nothing to point along.
  const railed = isMobile || state === "expanded";
  const activeRoute = useHighlightedRoute();
  const modifier = useShortcutModifier();
  const needsAction = useNeedsActionCount();
  const needingPerson = useVisitsNeedingPerson().length;
  const closeMobile = () => setOpenMobile(false);
  // Settings sits beside the account at the bottom, not in the list.
  const sections = useNavSections().map((section) => ({ ...section, entries: section.entries.filter((item) => item.id !== "settings") })).filter((section) => section.entries.length > 0);
  const settingsLabel = useNavLabel("settings");
  // Settings is for people who may open at least one of its sections, the same rule as the page's server guard.
  const settingsAvailable = useEntryAvailable()("settings");
  const { canEdit: canCustomize, resolved } = useSidebarSettings();
  const clinical = isClinicalBusinessType(useBusinessProfile().businessType);
  const logoUrl = useOptionalStaffSnapshot()?.snapshot?.catalog.clinic.logoUrl ?? null;

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {businesses.length > 1 ? (
              <BusinessSwitcher businesses={businesses} logoUrl={logoUrl} clinical={clinical} subtitle={resolved.sections[0]?.label} onNavigate={closeMobile} />
            ) : (
              <SidebarMenuButton size="lg" tooltip={clinicName} className="group-has-data-[sidebar=menu-action]/menu-item:pe-10" onClick={closeMobile} render={<Link href="/dashboard" />}>
                {/* The business logo once one is added (on My profile or in Settings), otherwise a plain mark. */}
                {logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a small saved picture, already resized on upload
                  <img src={logoUrl} alt="" className="aspect-square size-8 shrink-0 rounded-lg bg-sidebar-accent object-cover" />
                ) : (
                  <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                    {clinical ? <Stethoscope aria-hidden="true" /> : <Store aria-hidden="true" />}
                  </span>
                )}
                <span className="grid min-w-0 flex-1 text-start text-sm leading-tight">
                  <span className="truncate font-medium">{clinicName}</span>
                  <span className="truncate text-xs text-muted-foreground">{resolved.sections[0]?.label}</span>
                </span>
              </SidebarMenuButton>
            )}
            <RowIconAction label="Search" hint={`${modifier}K`} onClick={() => { closeMobile(); onSearch(); }}>
              <Search aria-hidden="true" />
            </RowIconAction>
          </SidebarMenuItem>
          {/* Folded to icons the row has no room for its button, so Search gets its own icon below the logo. */}
          <SidebarMenuItem className="hidden group-data-[collapsible=icon]:block">
            <SidebarMenuButton tooltip={`Search (${modifier}K)`} onClick={onSearch}>
              <Search aria-hidden="true" />
              <span>Search</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {sections.map((section) => (
          <SidebarGroup key={section.id} role={railed ? undefined : "navigation"} aria-label={railed ? undefined : section.label}>
            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
            {canCustomize ? (
              <Menu>
                <MenuTrigger render={<SidebarGroupAction aria-label={`${section.label} options`} />}>
                  <Ellipsis aria-hidden="true" />
                </MenuTrigger>
                <MenuPopup align="start" side="right">
                  <MenuItem onClick={() => { closeMobile(); requestCustomizeSidebar(); }}>
                    <PanelLeft aria-hidden="true" />
                    Customize sidebar
                  </MenuItem>
                </MenuPopup>
              </Menu>
            ) : null}
            <SidebarGroupContent>
              {railed ? (
                <HookSidebar
                  aria-label={section.label}
                  className="pt-1"
                  value={section.entries.findIndex((item) => item.id === activeRoute)}
                  items={section.entries.map((item) => {
                    const count = item.id === "dashboard" ? needsAction : item.id === "messages" ? needingPerson : null;
                    return {
                      id: item.id,
                      label: item.label,
                      icon: item.icon,
                      href: item.id === "your-page" ? `/b/${clinicSlug}` : item.href,
                      trailing: count ? <Badge variant="secondary" className="tabular-nums" aria-label={`${count} need action`}>{count}</Badge> : null,
                    };
                  })}
                  onChange={(index) => {
                    const id = section.entries[index]?.id;
                    closeMobile();
                    if (id === "settings") onOpenSettings();
                    else if (id === "help") onOpenHelp();
                  }}
                />
              ) : (
              <SidebarMenu>
                {section.entries.map((item) => {
                  const count = item.id === "dashboard" ? needsAction : item.id === "messages" ? needingPerson : null;
                  const href = item.id === "your-page" ? `/b/${clinicSlug}` : item.href;
                  const action = item.id === "settings" ? onOpenSettings : item.id === "help" ? onOpenHelp : null;
                  return (
                    <SidebarMenuItem key={item.id}>
                      <NavEntryButton item={item} href={href} active={item.id === activeRoute} onNavigate={closeMobile} onAction={action} />
                      {count ? <SidebarMenuBadge aria-label={`${count} need action`}>{count}</SidebarMenuBadge> : null}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <BookingLinkPin slug={clinicSlug} preview={preview} />
        <SidebarMenu>
          <SidebarMenuItem>
            <AccountMenu userName={userName} userEmail={userEmail} role={role} jobTitle={jobTitle} preview={preview} ownPractitionerId={ownPractitionerId} ownPhotoUrl={ownPhotoUrl} />
            {settingsAvailable ? (
              <RowIconAction label={settingsLabel} navId="settings" onClick={() => { closeMobile(); onOpenSettings(); }}>
                <Settings aria-hidden="true" />
              </RowIconAction>
            ) : null}
          </SidebarMenuItem>
          {/* Folded to icons, Settings gets its own icon above the account. */}
          {settingsAvailable ? (
            <SidebarMenuItem className="order-first hidden group-data-[collapsible=icon]:block">
              <SidebarMenuButton data-nav-id="settings" tooltip={settingsLabel} onClick={onOpenSettings}>
                <Settings aria-hidden="true" />
                <span>{settingsLabel}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** The places a phone user goes all day, within thumb reach. "More" opens the full menu. */
const phoneBarEntries = [
  { id: "dashboard", icon: LayoutDashboard },
  { id: "schedule", icon: CalendarDays },
  { id: "patients", icon: UsersRound },
  { id: "messages", icon: MessagesSquare },
] as const;

function PhoneBottomBar() {
  const activeRoute = useHighlightedRoute();
  const { resolved } = useSidebarSettings();
  const available = useEntryAvailable();
  const needsAction = useNeedsActionCount();
  const needingPerson = useVisitsNeedingPerson().length;
  const { setOpenMobile } = useSidebar();
  // An entry the business hid from the sidebar leaves the bar too, and so does one this person may not open; "More" still reaches everything they can.
  const items = phoneBarEntries
    .filter((entry) => available(entry.id) && !resolved.entries[entry.id].hidden)
    .map((entry) => ({
      ...entry,
      href: entryActions[entry.id].href ?? "/dashboard",
      label: resolved.entries[entry.id].label,
      count: entry.id === "dashboard" ? needsAction : entry.id === "messages" ? needingPerson : null,
    }));
  const itemClass = "relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[0.6875rem] font-medium text-muted-foreground outline-none transition-colors focus-visible:bg-accent focus-visible:text-foreground aria-[current=page]:text-foreground [&_svg]:size-5";
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 flex border-t bg-background pb-[env(safe-area-inset-bottom)] sm:hidden">
      {items.map((item) => (
        <Link key={item.id} data-nav-id={item.id} href={item.href} aria-current={item.id === activeRoute ? "page" : undefined} className={itemClass}>
          <span className="relative">
            <item.icon aria-hidden="true" />
            {item.count ? <span className="absolute -top-1.5 left-3 min-w-4 rounded-full bg-primary px-1 text-center text-[0.625rem] leading-4 text-primary-foreground tabular-nums" aria-label={`${item.count} need action`}>{item.count}</span> : null}
          </span>
          <span className="max-w-full truncate">{item.label}</span>
        </Link>
      ))}
      <button type="button" className={itemClass} onClick={() => setOpenMobile(true)}>
        <Ellipsis aria-hidden="true" />
        More
      </button>
    </nav>
  );
}

function ClinicBreadcrumb() {
  const activeRoute = useActiveRoute();
  const pathname = usePathname();
  const labels = useNavLabels();
  const t = useTerms();
  const askedSection = useSearchParams().get("section");
  const settingsSections = useSettingsSections().all;
  const onSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const section = onSettings
    ? { href: "/settings", label: labels.settings }
    : { href: entryActions[activeRoute].href ?? "/dashboard", label: labels[activeRoute] };
  const leaf = pathname === "/appointments/new"
    ? `New ${t.appointment}`
    : pathname.startsWith("/appointments/")
      ? t.Appointment
      : pathname === "/settings"
        ? pickSettingsSection(askedSection, settingsSections)?.title ?? null
        : null;
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {leaf ? (
          <>
            <BreadcrumbItem className="hidden sm:inline-flex">
              <BreadcrumbLink render={<Link href={section.href} />}>{section.label}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="hidden sm:block" />
            <BreadcrumbItem><BreadcrumbPage className="truncate">{leaf}</BreadcrumbPage></BreadcrumbItem>
          </>
        ) : (
          <BreadcrumbItem className="min-w-0"><BreadcrumbPage className="truncate">{section.label}</BreadcrumbPage></BreadcrumbItem>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function ClinicHeader({ preview }: {
  preview: boolean;
}) {
  const t = useTerms();
  const pathname = usePathname();
  // Schedule has its own button, which carries the date and location being viewed.
  const showNewAppointment = pathname !== "/appointments/new" && pathname !== "/schedule" && !pathname.startsWith("/settings");
  const { openNewVisit } = useNewVisit();
  return (
    <header className="sticky top-[var(--support-banner-height,0px)] z-20 flex h-14 shrink-0 items-center gap-2 bg-background px-4">
      <SidebarTrigger className="-ms-1.5" />
      <Separator orientation="vertical" className="me-1 h-4" />
      <ClinicBreadcrumb />
      <div className="ms-auto flex shrink-0 items-center gap-2">
        {preview ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger render={<Badge variant="info" className="hidden sm:inline-flex" />}>Preview</TooltipTrigger>
              <TooltipPopup>Sample data. Changes stay in this browser session.</TooltipPopup>
            </Tooltip>
          </TooltipProvider>
        ) : null}
        <NotificationBell preview={preview} />
        {preview ? null : <CopilotPanel />}
        {showNewAppointment ? (
          <Button size="sm" className="max-sm:w-8 max-sm:px-0" onClick={() => openNewVisit()}>
            <Plus aria-hidden="true" />
            <span className="max-sm:sr-only">New {t.appointment}</span>
          </Button>
        ) : null}
      </div>
    </header>
  );
}

/** Draws the frame in dark colours from the first paint when the person chose dark, before the page's own class can follow. */
function ThemedRoot({ children }: { children: ReactNode }) {
  const { resolved } = useStaffTheme();
  return <div className={cn("contents", resolved === "dark" && "dark")}>{children}</div>;
}

export function ClinicFrame({
  clinicName,
  clinicSlug,
  userName,
  userEmail,
  role,
  permissions,
  userId,
  jobTitle = null,
  ownPractitionerId = null,
  ownPhotoUrl = null,
  businesses = [],
  invites = [],
  preview,
  sidebarOpen,
  layout = emptyWorkspaceLayout,
  initialTheme = "light",
  impersonation,
  prefetched,
  viewport = null,
  children,
}: {
  clinicName: string;
  clinicSlug: string;
  userName: string;
  userEmail: string;
  role: StaffRole;
  permissions: Permission[];
  userId: string | null;
  /** What this person is called in the business ("Senior stylist"), shown under their name. */
  jobTitle?: string | null;
  /** The signed-in person's own booking profile, when they have one: its photo leads the account menu. */
  ownPractitionerId?: string | null;
  /** The photo of a person with no booking profile, set on My profile. */
  ownPhotoUrl?: string | null;
  /** Every business this login works in (name and own role only). The switcher shows with two or more. */
  businesses?: OwnBusiness[];
  /** Invites from other businesses waiting for this login's answer, shown above every screen until answered. */
  invites?: MyInvite[];
  preview: boolean;
  sidebarOpen: boolean;
  layout?: WorkspaceLayout;
  initialTheme?: ThemeChoice;
  /** Set while a Kalendr operator is viewing this business; shows the support banner on every screen. */
  impersonation?: ImpersonationFacts;
  /** Staff data the server loaded with the page, handed to the query cache. */
  prefetched?: DehydratedState;
  /** The server's guess at the device, so the first HTML uses its layout. */
  viewport?: ViewportGuess | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  // The frame stays mounted across pages, so its shape follows the address.
  const bounded = isBoundedPath(pathname);
  // Settings is its own page with its own sidebar; everything under /settings (import, privacy requests) keeps that sidebar.
  const onSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const [helpOpen, setHelpOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [sidebarEditorOpen, setSidebarEditorOpen] = useState(false);
  // Once opened, a dialog stays mounted so it can animate closed and keep what was typed.
  const [opened, setOpened] = useState({ command: false, help: false });
  // The frame outlives each page, so a dialog left open (say, before pressing Back) closes when the address changes.
  const [shownPath, setShownPath] = useState(pathname);
  // Where Settings' back button returns to: the last app page before Settings was opened.
  const [appPath, setAppPath] = useState(onSettings ? "/dashboard" : pathname);
  if (shownPath !== pathname) {
    setShownPath(pathname);
    setHelpOpen(false);
    setCommandOpen(false);
    if (!onSettings) setAppPath(pathname);
  }
  if ((commandOpen && !opened.command) || (helpOpen && !opened.help)) setOpened({ command: opened.command || commandOpen, help: opened.help || helpOpen });

  const showSettings = () => { setHelpOpen(false); router.push(settingsHref()); };
  const showHelp = () => { setHelpOpen(true); };
  // The upgrade dialog, billing banners and setup checklist open the Settings page at a section.
  useEffect(() => {
    const stopBilling = onBillingRequest(() => { setHelpOpen(false); router.push(settingsHref("billing")); });
    const stopSettings = onSettingsRequest(() => { setHelpOpen(false); router.push(settingsHref(takeSettingsRequest())); });
    // "Customize sidebar" from a section heading's ⋯ opens its panel over the page.
    const stopCustomize = onCustomizeSidebarRequest(() => setSidebarEditorOpen(true));
    return () => { stopBilling(); stopSettings(); stopCustomize(); };
  }, [router]);
  const billingEnabled = !preview && role === "owner";
  // ⌘K / Ctrl+K lives here, not in the palette, because the palette only mounts once it is first opened.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Chrome sends a keydown without a key when it autofills a field.
      if (event.key?.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setCommandOpen((current) => !current);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Settings can rename the business or change roles. The frame stays mounted, so on leaving Settings
  // ask the server for the frame's facts again.
  const wasOnSettings = useRef(onSettings);
  useEffect(() => {
    if (wasOnSettings.current && !onSettings) router.refresh();
    wasOnSettings.current = onSettings;
  }, [onSettings, router]);

  const frame = (
    <ThemedRoot>
    <ShortcutsProvider onSearch={() => setCommandOpen(true)}>
    {/* From 768px the page sits in a rounded panel 8px in from the window, as on cal.com: the panel scrolls, not the window,
        so its corners and gap stay put. Phones keep the full-bleed page and window scrolling. */}
    <SidebarProvider defaultOpen={sidebarOpen} className="md:h-svh md:overflow-hidden">
      <UpgradePromptProvider billingEnabled={billingEnabled} isOwner={role === "owner"}>
      <NewVisitProvider>
      <a className="skip-link" href="#clinic-main">Skip to workspace</a>
      {onSettings ? (
        <SettingsSidebar backHref={appPath} clinicName={clinicName} />
      ) : (
        <ClinicSidebar
          clinicName={clinicName}
          clinicSlug={clinicSlug}
          userName={userName}
          userEmail={userEmail}
          role={role}
          jobTitle={jobTitle}
          preview={preview}
          ownPractitionerId={ownPractitionerId}
          ownPhotoUrl={ownPhotoUrl}
          businesses={businesses}
          onOpenSettings={showSettings}
          onOpenHelp={showHelp}
          onSearch={() => setCommandOpen(true)}
        />
      )}
      <SidebarInset id="clinic-main" className="min-w-0 md:h-[calc(100svh-1rem)] md:overflow-hidden">
        {/* The panel scrolls with coss's scroll area (a thin bar that shows while scrolling or hovered), not the browser's bar.
            Below 768px the viewport is left unclipped, so the window scrolls and the app bar stays stuck to the top. */}
        <ScrollAreaPrimitive.Root className="flex min-h-0 min-w-0 flex-1 flex-col rounded-[inherit]">
          <ScrollAreaPrimitive.Viewport className="min-w-0 flex-1 rounded-[inherit] outline-none max-md:overflow-visible!" data-slot="scroll-area-viewport">
            <ScrollAreaPrimitive.Content className={cn("flex min-h-svh min-w-0 flex-col md:min-h-full", bounded && "lg:h-full")} style={{ minWidth: 0 }}>
              {impersonation ? <ImpersonationBanner impersonation={impersonation} /> : null}
              <ClinicHeader preview={preview} />
              {preview ? null : <OfflineBanner />}
              <BillingBanners enabled={billingEnabled} />
              <PendingInvites invites={invites} className="flex flex-col gap-2 px-4 pt-4 sm:px-6" />
              {/* Phones always clear the bottom bar here, so a page's own gutter stays equal on every side. */}
              <div className={cn("min-w-0 flex-1 max-sm:pb-[calc(3.5rem+env(safe-area-inset-bottom))]", bounded && "lg:min-h-0 lg:overflow-hidden")}>
                {preview ? children : <WorkspaceStatus>{children}</WorkspaceStatus>}
              </div>
            </ScrollAreaPrimitive.Content>
          </ScrollAreaPrimitive.Viewport>
          <ScrollBar orientation="vertical" className="z-30 max-md:hidden" />
        </ScrollAreaPrimitive.Root>
      </SidebarInset>
      <PhoneBottomBar />
      {opened.command ? (
        <ClinicCommand
          open={commandOpen}
          onOpenChange={setCommandOpen}
          clinicSlug={clinicSlug}
          onOpenSettings={showSettings}
          onOpenHelp={showHelp}
        />
      ) : null}
      {preview ? null : <AppSupport scope={`${clinicSlug}:${userId ?? ""}`} appName="Kalendr" />}
      <CustomizeSidebarDrawer open={sidebarEditorOpen} onOpenChange={setSidebarEditorOpen} />
      {opened.help ? <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} clinicSlug={clinicSlug} /> : null}
      {preview ? null : <ProductTour />}
      </NewVisitProvider>
      </UpgradePromptProvider>
    </SidebarProvider>
    </ShortcutsProvider>
    </ThemedRoot>
  );

  return (
    <NuqsAdapter><ViewportGuessProvider guess={viewport}>
      <StaffThemeProvider initial={initialTheme}>
        <StaffQueryProvider key={`${clinicSlug}:${userId ?? "preview"}`} scope={`${clinicSlug}:${userId ?? "preview"}`} prefetched={prefetched}>
          <StaffAccessProvider role={role} permissions={permissions} userId={userId} ownPractitionerId={ownPractitionerId}>
            <StepUpProvider>
            <WorkspaceLayoutProvider
              initial={layout}
              preview={preview}
              canEdit={(role === "owner" || role === "admin") && permissions.includes("settings.manage")}
            >
              {preview
                ? <StaffBusinessProfile>{frame}</StaffBusinessProfile>
                : <StaffSnapshotProvider role={role}><StaffBusinessProfile>{frame}</StaffBusinessProfile></StaffSnapshotProvider>}
            </WorkspaceLayoutProvider>
            </StepUpProvider>
          </StaffAccessProvider>
        </StaffQueryProvider>
      </StaffThemeProvider>
    </ViewportGuessProvider></NuqsAdapter>
  );
}
