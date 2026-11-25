"use client";

import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/money";
import type { ValidateCouponResult } from "@/lib/offers-contracts";

/** A code the customer typed that the server said works for this service. The booking sends only `code`; the server prices it again. */
export interface AppliedCode {
  serviceId: string;
  code: string;
  description: string;
  discountMinor: number;
  netMinor: number;
  currency: string;
}

async function checkCode(clinicSlug: string, serviceId: string, code: string): Promise<ValidateCouponResult> {
  const response = await fetch("/api/public/coupons/validate", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ clinicSlug, serviceId, code }),
  });
  const body: unknown = await response.json().catch(() => undefined);
  const data = typeof body === "object" && body !== null && "data" in body ? (body as { data?: unknown }).data : undefined;
  if (response.ok && typeof data === "object" && data !== null && "valid" in data) return data as ValidateCouponResult;
  const error = typeof body === "object" && body !== null && "error" in body ? (body as { error?: { code?: unknown; message?: unknown } }).error : undefined;
  if (error?.code === "preview_only") return { valid: false, message: "Codes are not available in the preview." };
  // A failed check says nothing about the code itself, only that it could not be checked.
  return { valid: false, message: typeof error?.message === "string" && error.message ? error.message : "We could not check that code. Try again." };
}

/**
 * "Have a code?" on the details step: a quiet link that opens a field. The check shows the price after the code; the booking
 * itself is priced by the server when it is made, so what is paid now comes from that answer, not from here.
 */
export function PublicCodeField({ clinicSlug, serviceId, applied, onApplied, serverError }: {
  clinicSlug: string;
  serviceId: string;
  applied: AppliedCode | null;
  onApplied: (next: AppliedCode | null) => void;
  /** A refusal the booking itself gave for the code, shown with the field. */
  serverError?: string;
}) {
  const inputId = useId();
  const noteId = `${inputId}-note`;
  const [open, setOpen] = useState(Boolean(applied) || Boolean(serverError));
  const [text, setText] = useState(applied?.code ?? "");
  const [message, setMessage] = useState("");
  const [checking, setChecking] = useState(false);
  const current = applied && applied.serviceId === serviceId ? applied : null;

  async function apply() {
    const code = text.trim();
    if (!code || checking) return;
    setChecking(true);
    setMessage("");
    try {
      const result = await checkCode(clinicSlug, serviceId, code);
      if (result.valid) onApplied({ serviceId, code, description: result.description, discountMinor: result.discountMinor, netMinor: result.netMinor, currency: result.currency });
      else { onApplied(null); setMessage(result.message); }
    } catch {
      setMessage("We could not check that code. Try again.");
    } finally {
      setChecking(false);
    }
  }

  function remove() {
    onApplied(null);
    setText("");
    setMessage("");
  }

  const problem = message || serverError || "";
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2">
      <CollapsibleTrigger render={<Button type="button" variant="link" className="min-h-11 self-start px-0 sm:min-h-8" />}>Have a code?</CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="flex flex-col gap-2 pb-1">
          {current ? (
            <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-success/32 bg-success/8 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="block font-medium">{current.code}: {current.description}</span>
                <span className="block text-muted-foreground tabular-nums">Price {formatMoney(current.netMinor, current.currency)} instead of {formatMoney(current.netMinor + current.discountMinor, current.currency)}. The amount to pay is confirmed when you book.</span>
              </span>
              <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-8" onClick={remove}>Remove</Button>
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <label htmlFor={inputId} className="font-medium text-base/4.5 sm:text-sm/4">Code</label>
                <Input
                  id={inputId}
                  size="lg"
                  autoComplete="off"
                  autoCapitalize="characters"
                  maxLength={40}
                  value={text}
                  aria-invalid={problem ? true : undefined}
                  aria-describedby={problem ? noteId : undefined}
                  onChange={(event) => { setText(event.target.value); setMessage(""); }}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void apply(); } }}
                />
                {problem ? <p id={noteId} role="alert" className="text-destructive-foreground text-xs">{problem}</p> : null}
              </div>
              <Button type="button" variant="outline" size="lg" className="mt-5 min-h-11 sm:mt-[1.375rem]" loading={checking} disabled={!text.trim()} onClick={() => void apply()}>Apply</Button>
            </div>
          )}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
