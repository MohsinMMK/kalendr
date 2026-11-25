"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useTerms } from "../terms/business-profile-context";
import { formatDateTime } from "./booking-format";
import type { ManageBookingSnapshot } from "./booking-types";
import { ConfirmingPayment, type PaymentOutcome } from "./confirming-payment";
import { fetchPaymentStatus, startPayment } from "./online-payment";
import { PayStep } from "./pay-step";

/** What the manage page's own booking address says about an appointment, as a payment outcome. */
function outcomeOf(status: string): PaymentOutcome {
  if (status === "pending_payment") return { state: "waiting", appointmentStatus: status };
  if (status === "expired") return { state: "expired", appointmentStatus: status };
  if (status === "cancelled") return { state: "cancelled", appointmentStatus: status };
  return { state: "confirmed", appointmentStatus: status };
}

/**
 * The manage page for a booking that is still waiting for payment. Coming back from a hosted checkout
 * (`?paid=1`) it shows "Confirming…" and watches the booking until the server says it is confirmed; otherwise it
 * offers "Pay now" with the time left. Nothing here marks anything paid.
 */
export function ManagePendingPayment({
  snapshot,
  token,
  bookingApi,
  paidReturn,
  onSnapshot,
  reload,
}: {
  snapshot: ManageBookingSnapshot;
  token: string;
  bookingApi: string;
  paidReturn: boolean;
  /** The booking changed (confirmed, expired or cancelled): show it. */
  onSnapshot: (snapshot: ManageBookingSnapshot) => void;
  reload: () => void;
}) {
  const t = useTerms();
  const { appointment, clinic, location, service } = snapshot;
  const input = { clinicSlug: clinic.slug, manageToken: token };
  const [confirming, setConfirming] = useState(paidReturn);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const latestReload = useRef(reload);
  useEffect(() => {
    latestReload.current = reload;
  });

  // How long the hold has left. A booking that already moved on is reloaded into its real state.
  useEffect(() => {
    if (confirming) return;
    let cancelled = false;
    fetchPaymentStatus({ clinicSlug: clinic.slug, manageToken: token })
      .then((status) => {
        if (cancelled) return;
        if (status.state === "waiting") setExpiresAt(status.expiresAt);
        else latestReload.current();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [confirming, clinic.slug, token]);

  const check = useCallback(async (): Promise<PaymentOutcome> => {
    const response = await fetch(bookingApi, { headers: { Accept: "application/json" }, cache: "no-store" });
    const payload: unknown = await response.json().catch(() => undefined);
    const data = (payload as { data?: ManageBookingSnapshot } | undefined)?.data;
    if (!response.ok || !data?.appointment || typeof data.appointment.status !== "string") throw new Error("Could not check.");
    const outcome = outcomeOf(data.appointment.status);
    if (outcome.state !== "waiting") onSnapshot(data);
    return outcome;
  }, [bookingApi, onSnapshot]);

  if (confirming) {
    return <ConfirmingPayment check={check} onConfirmed={() => undefined} />;
  }

  return (
    <PayStep
      dueNowMinor={service.payment?.dueNowMinor ?? null}
      dueLaterMinor={service.payment?.dueLaterMinor ?? null}
      currency={service.payment?.currency ?? "INR"}
      expiresAt={expiresAt}
      start={() => startPayment(input)}
      onConfirming={() => setConfirming(true)}
      onExpired={() => undefined}
      expiredAction={{ label: `See your ${t.appointment}`, onClick: reload }}
      details={
        <p className="text-sm">
          <span className="font-medium">{service.name}</span>
          {" · "}
          {formatDateTime(appointment.startsAt, clinic.locale, location.timezone)}
        </p>
      }
    />
  );
}
