"use client";

import { Check, Copy, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toastManager } from "@/components/ui/toast";

import { StaffApiError } from "../queries/http";

const stamp = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

export const formatStamp = (iso: string): string => stamp.format(new Date(iso));
export const formatDay = (iso: string): string => day.format(new Date(iso));

/** Plain words for a failed call, never a stack or a code. */
export function errorText(cause: unknown, fallback: string): string {
  return cause instanceof StaffApiError && cause.message ? cause.message : fallback;
}

/** Messages the server put against a field, first one per field. */
export function serverFieldErrors(cause: unknown): Record<string, string> {
  if (!(cause instanceof StaffApiError)) return {};
  return Object.fromEntries(Object.entries(cause.fieldErrors).flatMap(([path, messages]) => (messages[0] ? [[path, messages[0]]] : [])));
}

/**
 * Shows a secret exactly once. The only way out is the button or the close icon, and the text says plainly that it
 * cannot be shown again; a click outside does not close it by accident.
 */
export function SecretRevealDialog({ open, title, description, label, secret, onDone }: {
  open: boolean;
  title: string;
  description: string;
  label: string;
  secret: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      toastManager.add({ title: "Copied", type: "success" });
    } catch {
      toastManager.add({ title: "Could not copy", description: "Select the text and copy it yourself.", type: "error" });
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { setCopied(false); onDone(); } }} disablePointerDismissal>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <Alert variant="warning">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>We cannot show this again</AlertTitle>
            <AlertDescription>Copy it now and keep it somewhere safe, such as a password manager. If you lose it, make a new one.</AlertDescription>
          </Alert>
          <div className="flex items-center gap-2">
            <Input size="lg" readOnly value={secret} aria-label={label} className="font-mono" onFocus={(event) => event.currentTarget.select()} />
            <Button type="button" variant="outline" size="icon-lg" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => void copy()}>
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            </Button>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" size="lg" onClick={() => { setCopied(false); onDone(); }}>I have saved it</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
