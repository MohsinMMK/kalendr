"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { useTerms } from "@/features/terms/business-profile-context";
import type { OutstandingBalance } from "@/lib/invoicing-contracts";
import { formatMoney } from "@/lib/money";

import { useCatalogLookups } from "./clinic-catalog";
import { staffQuery } from "./queries/http";
import { useStaffAccess } from "./staff-access";

/**
 * What a customer still owes on issued invoices. A small extra on screens that already work without it, so it reads
 * once and stays silent when it cannot: in the preview, without payment rights, or when the answer fails.
 */
export function useOutstandingBalance(patientId: string | undefined): OutstandingBalance | null {
  const live = useCatalogLookups().database;
  const allowed = useStaffAccess().can("payments.collect");
  const [loaded, setLoaded] = useState<{ patientId: string; balance: OutstandingBalance } | null>(null);
  useEffect(() => {
    if (!live || !allowed || !patientId) return;
    const controller = new AbortController();
    staffQuery<OutstandingBalance>(`/api/staff/invoices/outstanding?patientId=${encodeURIComponent(patientId)}`, controller.signal)
      .then((balance) => setLoaded({ patientId, balance }))
      .catch(() => undefined);
    return () => controller.abort();
  }, [live, allowed, patientId]);
  return loaded && loaded.patientId === patientId && loaded.balance.dueMinor > 0 ? loaded.balance : null;
}

/** "Owes ₹X" with a link to the invoices that make it up. */
export function OwesBadge({ patientId, className }: { patientId: string; className?: string }) {
  const balance = useOutstandingBalance(patientId);
  if (!balance) return null;
  const count = balance.invoices.length;
  return (
    <Link href="/billing" className={`inline-flex min-h-11 items-center sm:min-h-0 ${className ?? ""}`} aria-label={`Owes ${formatMoney(balance.dueMinor, balance.currency)} on ${count} ${count === 1 ? "invoice" : "invoices"}. Open billing.`}>
      <Badge variant="warning" size="lg">Owes {formatMoney(balance.dueMinor, balance.currency)}</Badge>
    </Link>
  );
}

/** A gentle note while booking: it does not block anything. */
export function OutstandingNotice({ patientId }: { patientId: string | undefined }) {
  const t = useTerms();
  const balance = useOutstandingBalance(patientId);
  if (!balance) return null;
  return (
    <p role="status" className="rounded-lg border border-warning/32 bg-warning/8 px-3 py-2 text-sm">
      This {t.customer} still owes {formatMoney(balance.dueMinor, balance.currency)} from earlier. You can book anyway and take it at the desk.
    </p>
  );
}
