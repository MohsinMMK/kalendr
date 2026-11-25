import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { OperatorsScreen } from "@/features/admin/operators-screen";
import { requireAdminPageContext } from "@/server/admin-context";

export const metadata: Metadata = { title: "Operators" };

export default async function Page() {
  const { role } = await requireAdminPageContext();
  if (role !== "super") notFound();
  return <OperatorsScreen />;
}
