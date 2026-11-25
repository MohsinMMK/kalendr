"use client";

import { Check, Copy } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { toastManager } from "@/components/ui/toast";

/** "rzp_test_AbCd1234EfGh" as "rzp_test_••••EfGh". Short ids (the built-in test account) are shown as they are. */
export function maskKeyId(keyId: string): string {
  return keyId.length > 14 ? `${keyId.slice(0, 9)}••••${keyId.slice(-4)}` : keyId;
}

export function checkedAt(iso: string | null): string {
  if (!iso) return "Not checked yet";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(iso));
}

/** A read-only value with a Copy button, for an address the person has to paste somewhere else. */
export function CopyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toastManager.add({ title: "Copied.", type: "success" });
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toastManager.add({ title: "Could not copy. Select the text and copy it instead.", type: "error" });
    }
  }
  return (
    <Field className="w-full">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex w-full items-center gap-2">
        <Input id={id} size="lg" readOnly value={value} className="min-w-0 flex-1" onFocus={(event) => event.currentTarget.select()} />
        <Button type="button" variant="outline" size="lg" className="shrink-0 min-h-11" onClick={() => void copy()} aria-label={`Copy ${label.toLowerCase()}`}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          <span className="max-sm:sr-only">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </Field>
  );
}

/** What a failed save says when the server wants a fresh second-factor code and the person did not give one. */
export const stepUpDeclined = "A fresh code is needed to change the payment account. Nothing was changed.";
