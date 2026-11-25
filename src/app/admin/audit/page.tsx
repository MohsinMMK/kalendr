import type { Metadata } from "next";

import { AuditScreen } from "@/features/admin/audit-screen";
import { requireAdminPageContext } from "@/server/admin-context";

export const metadata: Metadata = { title: "Audit" };

export default async function Page({ searchParams }: { searchParams: Promise<{ tenant?: string | string[] }> }) {
  await requireAdminPageContext();
  const { tenant } = await searchParams;
  return <AuditScreen initialTenant={typeof tenant === "string" ? tenant.slice(0, 80) : ""} />;
}
