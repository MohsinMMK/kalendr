"use client";

import { usePathname, useSearchParams } from "next/navigation";

export type ClinicRoute = "dashboard" | "schedule" | "bookings" | "patients" | "follow-ups" | "classes" | "messages" | "doctors" | "records" | "billing" | "offers" | "campaigns" | "routing-forms" | "services" | "reports" | "reviews" | "spam" | "activity" | "profile";

const routes: ReadonlySet<string> = new Set<ClinicRoute>(["dashboard", "schedule", "bookings", "patients", "follow-ups", "classes", "messages", "doctors", "records", "billing", "offers", "campaigns", "routing-forms", "services", "reports", "reviews", "spam", "activity", "profile"]);

/**
 * Which sidebar entry a staff address belongs to. An appointment screen belongs to the page it was
 * opened from (`?from=`), so the sidebar and breadcrumb keep pointing back there.
 */
export function activeRouteFor(pathname: string, from: string | null): ClinicRoute {
  const [first, second] = pathname.split("/").filter(Boolean);
  if (first === "appointments") {
    if (second === "new") return from === "schedule" ? "schedule" : "dashboard";
    if (second === "series") return from === "dashboard" || from === "bookings" ? from : "schedule";
    return from === "dashboard" || from === "patients" ? from : "schedule";
  }
  if (first === "settings") return "dashboard";
  return first && routes.has(first) ? (first as ClinicRoute) : "dashboard";
}

/** Pages that fill the screen on desktop, so their lists and calendars scroll inside the frame. */
export function isBoundedPath(pathname: string): boolean {
  return pathname === "/dashboard" || pathname === "/schedule" || pathname === "/bookings";
}

/** The sidebar entry for the current address. Read in the sidebar and header only, so filter changes in the address do not re-render the whole frame. */
export function useActiveRoute(): ClinicRoute {
  const pathname = usePathname();
  const from = useSearchParams().get("from");
  return activeRouteFor(pathname, from);
}
