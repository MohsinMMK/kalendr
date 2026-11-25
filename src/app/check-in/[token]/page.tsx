import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { getManageSnapshot } from "@/server/appointment-repository";
import { isPreviewMode } from "@/server/preview-repository";
import { getStaffContext, type StaffContext } from "@/server/staff-context";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Check in",
  robots: { index: false, follow: false },
};

const tokenPattern = /^[A-Za-z0-9_-]{8,200}$/;

/**
 * Where the booking's QR code points. A signed-in team member of the same business goes to the
 * appointment's check-in screen, which asks before checking in. Anyone else, the customer included,
 * goes to the customer's own manage page.
 */
export default async function CheckInPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!tokenPattern.test(token)) notFound();
  const managePath = `/manage/${encodeURIComponent(token)}`;
  if (isPreviewMode()) redirect(managePath);

  const snapshot = await getManageSnapshot(token).catch(() => null);
  if (!snapshot) redirect(managePath);

  let staff: StaffContext | null = null;
  try {
    staff = await getStaffContext(await headers(), snapshot.clinic.slug);
  } catch {
    staff = null;
  }
  if (!staff || staff.preview || staff.tenantId !== snapshot.clinic.id) redirect(managePath);

  redirect(`/appointments/${encodeURIComponent(snapshot.appointment.id)}?from=dashboard`);
}
