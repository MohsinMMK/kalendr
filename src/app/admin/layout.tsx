import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AdminShell } from "@/features/admin/admin-shell";
import { requireAdminPageContext } from "@/server/admin-context";

export const metadata: Metadata = {
  title: { default: "Operators", template: "%s · Kalendr operators" },
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** Anyone who is not an operator gets the ordinary 404, so a guessed /admin reveals nothing. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { role } = await requireAdminPageContext();
  return <AdminShell role={role}>{children}</AdminShell>;
}
