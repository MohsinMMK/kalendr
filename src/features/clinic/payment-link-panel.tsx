"use client";

import { Link2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useTerms } from "@/features/terms/business-profile-context";
import { formatMoney } from "@/lib/money";
import type { PaymentLinkResult } from "@/lib/payments";

import { CopyField } from "./payment-parts";
import { staffMutation } from "./queries/http";

function until(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(iso));
}

/** Makes a pay link for a visit that still owes money, and shows it to copy. Sending it by message is not built yet, so the desk pastes it into their own message. */
export function PaymentLinkPanel({ appointmentId, onClose }: { appointmentId: string; onClose: () => void }) {
  const t = useTerms();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<PaymentLinkResult | null>(null);

  async function create() {
    setBusy(true);
    setError("");
    try {
      setResult(await staffMutation<PaymentLinkResult>(`/api/staff/appointments/${appointmentId}/payment-link`, "POST", { send: false }));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "The link could not be made. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Payment link" className="flex flex-col gap-3 rounded-lg border bg-muted/50 p-3">
      <div>
        <h3 className="font-medium text-sm">Send a payment link</h3>
        <p className="text-muted-foreground text-xs">Copy the link and send it to the {t.customer} yourself. They pay online, and the payment shows here once it arrives.</p>
      </div>
      {error ? <p role="alert" className="text-destructive-foreground text-sm">{error}</p> : null}
      {result ? (
        <>
          <CopyField label="Payment link" value={result.url} hint={`${formatMoney(result.amountMinor, result.currency)} · works until ${until(result.expiresAt)}`} />
          <div className="flex justify-end"><Button type="button" size="sm" variant="ghost" className="min-h-11 sm:min-h-8" onClick={onClose}>Done</Button></div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" className="min-h-11 sm:min-h-8" onClick={onClose}>Cancel</Button>
            <Button type="button" size="sm" className="min-h-11 sm:min-h-8" loading={busy} onClick={() => void create()}><Link2 aria-hidden="true" />Make link</Button>
          </div>
        </>
      )}
    </section>
  );
}
