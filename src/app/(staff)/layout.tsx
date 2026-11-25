import type { ReactNode } from "react";

import { ClinicShell } from "@/features/clinic/clinic-shell";

/**
 * The sidebar, header and dialogs every staff page shares. As a layout it renders once and stays
 * mounted while staff move between pages, so only the page itself loads on each click.
 * Each page still checks who is signed in, because a layout does not run again on navigation.
 */
export default function StaffLayout({ children }: { children: ReactNode }) {
  return <ClinicShell>{children}</ClinicShell>;
}
