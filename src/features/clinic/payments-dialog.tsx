"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link2, MoreHorizontal, Undo2 } from "lucide-react";

import { SelectField, TextField } from "@/components/form-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { amountInputValue, formatMoney, parseAmountInput } from "@/lib/money";
import type { PaymentProviderId } from "@/lib/payments";
import type { PaymentMethod, PaymentView, VisitPayments } from "@/server/payments";

import { PaymentLinkPanel } from "./payment-link-panel";
import { staffMutation, staffQuery, useOptionalStaffSnapshot } from "./staff-snapshot-provider";

const methodLabels: Record<PaymentMethod, string> = { cash: "Cash", upi: "UPI", card: "Card", bank: "Bank transfer", other: "Other" };
const methodOptions = (Object.keys(methodLabels) as PaymentMethod[]).map((value) => ({ value, label: methodLabels[value] }));

/**
 * What the server adds to a payment taken online (feature 23). Read as optional here so the desk screen keeps working
 * against a server that has not sent them; the intersection also accepts the server's own fields once they exist.
 */
type OnlineFields = { provider?: PaymentProviderId | null; isTest?: boolean; pendingRefundMinor?: number };
type DialogPayment = PaymentView & OnlineFields;

function paidAt(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(new Date(iso));
}

/** Gives money back against one payment. The reason stays with the refund and out of the activity log. */
function RefundForm({ payment, currency, onDone, onCancel }: {
  payment: DialogPayment;
  currency: string;
  onDone: (next: VisitPayments) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(amountInputValue(payment.refundableMinor));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // One key per attempt: a double click or a retried request gives back once.
  const key = useRef(crypto.randomUUID());
  const amountMinor = parseAmountInput(amount);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    if (!amountMinor || amountMinor > payment.refundableMinor) {
      setError(`Enter up to ${formatMoney(payment.refundableMinor, currency)}.`);
      return;
    }
    if (reason.trim().length < 2) {
      setError("Say why, so the books make sense later.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const next = await staffMutation<VisitPayments>(`/api/staff/payments/${payment.id}/refunds`, "POST", { amountMinor, reason: reason.trim() }, { idempotencyKey: key.current });
      // An online refund is only asked for here: the provider confirms it later (the server answers 202).
      if (payment.provider) toastManager.add({ title: "Refund sent to the provider", description: `${formatMoney(amountMinor, currency)} shows as pending until they confirm it.`, type: "success" });
      else toastManager.add({ title: `Gave back ${formatMoney(amountMinor, currency)}`, type: "success" });
      onDone(next);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Could not save. Try again.");
      key.current = crypto.randomUUID();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Form className="flex flex-col gap-3 rounded-lg border bg-muted/50 p-3" onSubmit={(event) => void submit(event)}>
      <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
        <TextField label="Give back" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
        <TextField label="Why" value={reason} maxLength={200} placeholder="Visit cut short" onChange={(event) => setReason(event.target.value)} />
      </div>
      {error ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" variant="destructive-outline" loading={saving}>Give back {amountMinor ? formatMoney(amountMinor, currency) : ""}</Button>
      </div>
    </Form>
  );
}

/** Takes money for one visit at the desk, shows what was paid, and gives refunds. */
export function PaymentsDialog({ appointmentId, name, onOpenChange, canRefund }: {
  /** The visit to take payment for; null keeps the dialog closed. */
  appointmentId: string | null;
  name: string;
  onOpenChange: (open: boolean) => void;
  canRefund: boolean;
}) {
  const staff = useOptionalStaffSnapshot();
  const [data, setData] = useState<VisitPayments | null>(null);
  const [loadError, setLoadError] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [refunding, setRefunding] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const key = useRef("");
  const formId = useId();

  useEffect(() => {
    if (!appointmentId) return;
    const controller = new AbortController();
    key.current = crypto.randomUUID();
    staffQuery<VisitPayments>(`/api/staff/appointments/${appointmentId}/payments`, controller.signal)
      .then((next) => {
        setData(next);
        setAmount(next.balance.dueMinor ? amountInputValue(next.balance.dueMinor) : "");
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : "Could not load payments.");
      });
    return () => controller.abort();
  }, [appointmentId]);

  function close(next: boolean) {
    if (!next) {
      setData(null);
      setLoadError("");
      setError("");
      setRefunding(null);
      setLinking(false);
      setMethod("cash");
    }
    onOpenChange(next);
  }

  function updated(next: VisitPayments) {
    setData(next);
    setRefunding(null);
    setAmount(next.balance.dueMinor ? amountInputValue(next.balance.dueMinor) : "");
    void staff?.refresh();
  }

  const currency = data?.currency ?? "INR";
  const balance = data?.balance;
  const amountMinor = parseAmountInput(amount);
  const settled = balance ? balance.priceMinor !== null && balance.dueMinor === 0 : false;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !appointmentId || !balance) return;
    if (!amountMinor) {
      setError("Enter an amount, like 800.");
      return;
    }
    if (balance.priceMinor !== null && amountMinor > balance.dueMinor) {
      setError(`Only ${formatMoney(balance.dueMinor, currency)} is due.`);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const next = await staffMutation<VisitPayments>(`/api/staff/appointments/${appointmentId}/payments`, "POST", { amountMinor, method }, { idempotencyKey: key.current });
      key.current = crypto.randomUUID();
      toastManager.add({ title: `Took ${formatMoney(amountMinor, currency)}`, description: `${methodLabels[method]} · ${name}`, type: "success" });
      updated(next);
      if (next.balance.priceMinor !== null && next.balance.dueMinor === 0) close(false);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Could not save. Try again.");
      key.current = crypto.randomUUID();
    } finally {
      setSaving(false);
    }
  }

  const owes = Boolean(balance && balance.priceMinor !== null && balance.dueMinor > 0);
  const summary = !balance ? "" : balance.priceMinor === null
    ? `No set price · ${formatMoney(balance.netPaidMinor, currency)} paid`
    : `${formatMoney(balance.priceMinor, currency)} · ${formatMoney(balance.netPaidMinor, currency)} paid · ${formatMoney(balance.dueMinor, currency)} due`;

  return (
    <Dialog open={Boolean(appointmentId)} onOpenChange={close}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Payment · {name}</DialogTitle>
          <DialogDescription>{summary || "Loading what is due…"}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
            {loadError ? <p role="alert" className="text-sm text-destructive-foreground">{loadError}</p> : null}
            {!data && !loadError ? <div className="flex justify-center py-6"><Spinner /></div> : null}
            {data && !settled ? (
              <Form id={formId} className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => void submit(event)}>
                <TextField label="Amount" inputMode="decimal" autoComplete="off" value={amount} placeholder="800" onChange={(event) => setAmount(event.target.value)} />
                <SelectField label="Paid by" value={method} onValueChange={(next) => setMethod((next || "cash") as PaymentMethod)} options={methodOptions} />
              </Form>
            ) : null}
            {data && settled ? <p className="rounded-lg border bg-muted/50 px-3 py-2 text-sm">Paid in full. Nothing is due.</p> : null}
            {linking && appointmentId && owes ? <PaymentLinkPanel appointmentId={appointmentId} onClose={() => setLinking(false)} /> : null}
            {data?.payments.length ? (
              <ul className="flex flex-col divide-y rounded-lg border" aria-label="Payments so far">
                {(data.payments as DialogPayment[]).map((payment) => (
                  <li key={payment.id} className="flex flex-col gap-2 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium tabular-nums">
                          <span>{formatMoney(payment.amountMinor, currency)} · {methodLabels[payment.method]}</span>
                          {payment.provider ? <Badge variant="info" size="sm">Online</Badge> : null}
                          {payment.isTest ? <Badge variant="warning" size="sm">Test payment</Badge> : null}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {paidAt(payment.at)}
                          {payment.refunds.length ? ` · ${formatMoney(payment.amountMinor - payment.refundableMinor, currency)} given back` : ""}
                        </p>
                        {(payment.pendingRefundMinor ?? 0) > 0 ? <p className="text-xs text-warning-foreground">Refund pending · {formatMoney(payment.pendingRefundMinor ?? 0, currency)}. The provider has not confirmed it yet.</p> : null}
                      </div>
                      {payment.refundableMinor === 0 && (payment.pendingRefundMinor ?? 0) > 0 ? <Badge variant="warning">Refund pending</Badge> : payment.refundableMinor === 0 ? <Badge variant="outline">Given back</Badge> : canRefund && refunding !== payment.id ? (
                        <Button type="button" size="sm" variant="ghost" onClick={() => setRefunding(payment.id)}><Undo2 aria-hidden="true" />Give back…</Button>
                      ) : null}
                    </div>
                    {refunding === payment.id ? (
                      <RefundForm payment={payment} currency={currency} onDone={updated} onCancel={() => setRefunding(null)} />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {error ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
        </DialogPanel>
        <DialogFooter className="flex-row items-center sm:justify-end">
          {owes ? (
            <Menu>
              <MenuTrigger render={<Button type="button" variant="outline" size="icon-lg" className="me-auto min-h-11 min-w-11 shrink-0" aria-label="More payment actions" />}><MoreHorizontal aria-hidden="true" /></MenuTrigger>
              <MenuPopup align="start">
                <MenuItem onClick={() => setLinking(true)}><Link2 aria-hidden="true" />Send payment link…</MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
          <DialogClose render={<Button variant="ghost" />}>{settled ? "Done" : "Cancel"}</DialogClose>
          {data && !settled ? <Button type="submit" form={formId} loading={saving}>Take {amountMinor ? formatMoney(amountMinor, currency) : "payment"}</Button> : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
