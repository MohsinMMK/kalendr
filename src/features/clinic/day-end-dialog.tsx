"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Lock, TriangleAlert } from "lucide-react";

import { SelectField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { amountInputValue, formatMoney } from "@/lib/money";
import type { DayEnd, DaySummary } from "@/server/day-end";
import type { PaymentMethod } from "@/server/payments";

import { staffMutation, staffQuery } from "./staff-snapshot-provider";

const methodLabels: Record<PaymentMethod, string> = { cash: "Cash", upi: "UPI", card: "Card", bank: "Bank transfer", other: "Other" };

/** The last week of days, newest first, as "Today", "Yesterday", then "Mon 17 Nov". */
export function recentDays(today: string, count = 7): { value: string; label: string }[] {
  const base = new Date(`${today}T12:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(base);
    date.setUTCDate(base.getUTCDate() - index);
    const value = date.toISOString().slice(0, 10);
    const label = index === 0 ? "Today" : index === 1 ? "Yesterday"
      : new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(date);
    return { value, label };
  });
}

/** What the desk typed for the cash count, in paise. Empty or bad input gives null; zero is a real count. */
export function parseCashCount(value: string): number | null {
  const cleaned = value.trim().replace(/^₹\s*/, "").replaceAll(",", "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) return null;
  const [rupees, paise = ""] = cleaned.split(".");
  return Number(rupees) * 100 + Number(paise.padEnd(2, "0"));
}

function closedAt(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", day: "numeric", month: "short" }).format(new Date(iso));
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col rounded-lg border px-3 py-2">
      <span className="truncate text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      {hint ? <span className="truncate text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function Row({ label, value, strong, muted }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-3 px-3 py-1.5 text-sm ${strong ? "font-semibold" : ""} ${muted ? "text-muted-foreground" : ""}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function SummaryView({ summary }: { summary: DaySummary }) {
  const { visits, money, currency } = summary;
  const amount = (minor: number) => formatMoney(minor, currency);
  const methods = (Object.keys(money.byMethod) as PaymentMethod[]).filter((method) => money.byMethod[method] > 0);
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Seen" value={`${visits.seen}`} hint={`of ${visits.total}${visits.walkIns ? ` · ${visits.walkIns} walk-in` : ""}`} />
        <Tile label="No-shows" value={`${visits.noShows}`} hint={visits.cancelled ? `${visits.cancelled} cancelled` : undefined} />
        <Tile label="Left unseen" value={`${visits.left}`} />
        <Tile label="Avg wait" value={visits.avgWaitMinutes === null ? "—" : `${visits.avgWaitMinutes} min`} hint={visits.avgVisitMinutes === null ? undefined : `${visits.avgVisitMinutes} min per visit`} />
      </div>
      <div className="flex flex-col divide-y rounded-lg border" aria-label="Money for the day">
        <div className="py-1">
          {methods.length === 0 ? <Row label="No payments taken" value={amount(0)} muted /> : methods.map((method) => (
            <Row key={method} label={methodLabels[method]} value={amount(money.byMethod[method])} />
          ))}
          {money.refundedMinor ? <Row label="Given back" value={`− ${amount(money.refundedMinor)}`} /> : null}
        </div>
        <div className="py-1">
          <Row label="Net taken" value={amount(money.netMinor)} strong />
          <Row label={money.owedCount ? `Still owed · ${money.owedCount} ${money.owedCount === 1 ? "visit" : "visits"}` : "Still owed"} value={amount(money.owedMinor)} muted={!money.owedMinor} />
        </div>
      </div>
    </>
  );
}

/** The day-end summary: who was seen, money by method, the cash count, and closing the day for good. */
export function DayEndDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [day, setDay] = useState<string | null>(null);
  const [data, setData] = useState<DayEnd | null>(null);
  const [loadError, setLoadError] = useState("");
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const key = useRef("");
  const formId = useId();

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    key.current = crypto.randomUUID();
    staffQuery<DayEnd>(`/api/staff/day-end${day ? `?day=${day}` : ""}`, controller.signal)
      .then((next) => {
        setData(next);
        setLoadError("");
        setCounted(next.close ? "" : amountInputValue(next.summary.money.cashExpectedMinor));
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : "Could not load the day.");
      });
    return () => controller.abort();
  }, [open, day]);

  function close(next: boolean) {
    if (!next) {
      setDay(null);
      setData(null);
      setLoadError("");
      setError("");
      setNote("");
    }
    onOpenChange(next);
  }

  function pickDay(next: string) {
    setData(null);
    setError("");
    setNote("");
    setDay(next);
  }

  const today = data?.today ?? null;
  const shownDay = day ?? today;
  const summary = data?.close?.summary ?? data?.summary;
  const currency = summary?.currency ?? "INR";
  const expected = data?.summary.money.cashExpectedMinor ?? 0;
  const countedMinor = parseCashCount(counted);
  const difference = countedMinor === null ? null : countedMinor - expected;
  const dayLabel = today && shownDay ? recentDays(today).find((item) => item.value === shownDay)?.label ?? shownDay : "";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !data || !shownDay) return;
    if (countedMinor === null) {
      setError("Enter what is in the cash drawer, like 2,400. Enter 0 if it is empty.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const next = await staffMutation<DayEnd>("/api/staff/day-end", "POST", {
        day: shownDay, locationId: data.summary.locationId, cashCountedMinor: countedMinor, ...(note.trim() ? { note: note.trim() } : {}),
      }, { idempotencyKey: key.current });
      key.current = crypto.randomUUID();
      setData(next);
      toastManager.add({ title: `${dayLabel} is closed`, description: `${formatMoney(next.summary.money.netMinor, currency)} net · cash ${formatMoney(countedMinor, currency)}`, type: "success" });
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Could not close the day. Try again.");
      key.current = crypto.randomUUID();
    } finally {
      setSaving(false);
    }
  }

  const description = !data ? "Loading the day…" : data.close
    ? `Closed ${closedAt(data.close.at)} by ${data.close.byName}`
    : `${summary?.locationName ?? ""} · count the cash drawer, then close the day`;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Day end{dayLabel ? ` · ${dayLabel}` : ""}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          {today ? (
            <SelectField label="Day" value={shownDay ?? today} onValueChange={(next) => { if (next) pickDay(next); }} options={recentDays(today)} />
          ) : null}
          {loadError ? <p role="alert" className="text-sm text-destructive-foreground">{loadError}</p> : null}
          {!data && !loadError ? <div className="flex justify-center py-6"><Spinner /></div> : null}
          {data && summary ? <SummaryView summary={summary} /> : null}

          {data?.close ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-col divide-y rounded-lg border bg-muted/50 py-1">
                <Row label="Cash expected" value={formatMoney(data.close.cashExpectedMinor, currency)} />
                <Row label="Cash counted" value={formatMoney(data.close.cashCountedMinor, currency)} strong />
                {data.close.cashCountedMinor !== data.close.cashExpectedMinor ? (
                  <Row
                    label={data.close.cashCountedMinor > data.close.cashExpectedMinor ? "Over" : "Short"}
                    value={formatMoney(Math.abs(data.close.cashCountedMinor - data.close.cashExpectedMinor), currency)}
                  />
                ) : null}
              </div>
              {data.close.note ? <p className="text-sm text-muted-foreground">“{data.close.note}”</p> : null}
              {data.changedSinceClose ? (
                <Alert variant="warning">
                  <TriangleAlert aria-hidden="true" />
                  <AlertTitle>Changed after closing</AlertTitle>
                  <AlertDescription>
                    Money or visits moved after this day was closed. The totals above are what was closed; now it is {formatMoney(data.summary.money.netMinor, currency)} net.
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>
          ) : null}

          {data && !data.close ? (
            <>
              {data.summary.visits.open ? (
                <Alert variant="warning">
                  <TriangleAlert aria-hidden="true" />
                  <AlertTitle>{data.summary.visits.open} still open</AlertTitle>
                  <AlertDescription>Mark them seen, no-show or left before closing, or they stay open on the record.</AlertDescription>
                </Alert>
              ) : null}
              <Form id={formId} className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => void submit(event)}>
                <TextField
                  label="Cash in the drawer"
                  inputMode="decimal"
                  autoComplete="off"
                  value={counted}
                  onChange={(event) => setCounted(event.target.value)}
                  hint={difference === null || difference === 0
                    ? `Expected ${formatMoney(expected, currency)}`
                    : `${difference > 0 ? "Over" : "Short"} by ${formatMoney(Math.abs(difference), currency)}`}
                />
                <TextField label="Note" optional maxLength={300} value={note} placeholder="₹100 short, kept aside" onChange={(event) => setNote(event.target.value)} />
              </Form>
            </>
          ) : null}
          {error ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>{data?.close ? "Done" : "Cancel"}</DialogClose>
          {data && !data.close ? (
            <Button type="submit" form={formId} loading={saving}><Lock aria-hidden="true" />Close {dayLabel === "Today" ? "today" : "day"}</Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
