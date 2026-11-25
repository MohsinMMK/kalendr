"use client";

import { useState } from "react";
import type { FormEvent } from "react";

import { SelectField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { delayOptions, quickMessageBody } from "@/lib/quick-messages";

import { useCatalogLookups } from "./clinic-catalog";
import { usePreviewAppointments } from "./preview-appointments";
import { stillToBeSeen, useQuickMessages } from "./use-quick-messages";

const everyone = "all";

/** Tells everyone still to be seen today that the business, or one practitioner, is running late. */
export function RunningLateDialog({ open, onOpenChange, practitionerId }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Starts on this practitioner, when Today is filtered to one. */
  practitionerId?: string;
}) {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const { appointments, operations } = usePreviewAppointments();
  const messages = useQuickMessages();
  const [minutes, setMinutes] = useState("15");
  const [who, setWho] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const chosen = who ?? practitionerId ?? everyone;
  const forPractitioner = chosen === everyone ? undefined : chosen;
  const count = stillToBeSeen(appointments, operations.clockIso, operations.visitTimings, forPractitioner).length;
  const audience = count === 1 ? `1 ${t.customer}` : `${count} ${t.customers}`;

  function close(next: boolean) {
    if (!next) {
      setWho(null);
      setError("");
    }
    onOpenChange(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !count) return;
    setSaving(true);
    setError("");
    try {
      const told = await messages.tellEveryoneLate(Number(minutes), forPractitioner);
      toastManager.add({
        title: told === 1 ? `Told 1 ${t.customer}` : `Told ${told} ${t.customers}`,
        description: `Running about ${minutes} min late${forPractitioner ? ` · ${catalog.practitionerName(forPractitioner)}` : ""}`,
        type: "success",
      });
      close(false);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Could not send. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Running late</DialogTitle>
          <DialogDescription>Tells {t.customers} who are booked or waiting today and not yet seen.</DialogDescription>
        </DialogHeader>
        <Form className="contents" onSubmit={(event) => void submit(event)}>
          <DialogPanel className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField label="About" value={minutes} onValueChange={(next) => setMinutes(next || "15")} options={delayOptions.map((value) => ({ value: String(value), label: `${value} minutes` }))} />
              <SelectField label="Whose" value={chosen} onValueChange={(next) => setWho(next || everyone)} options={[{ value: everyone, label: `Every ${t.practitioner}` }, ...catalog.practitioners.map((person) => ({ value: person.id, label: person.name }))]} />
            </div>
            <div className="rounded-lg border bg-muted/50 px-3 py-2 text-sm">
              <p className="text-xs text-muted-foreground">{count ? `${audience} will get` : `No ${t.customers} left to tell today`}</p>
              <p>{catalog.clinic.name}: {quickMessageBody("running_late", t, { delayMinutes: Number(minutes) })}</p>
            </div>
            {error ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button type="submit" loading={saving} disabled={!count}>{count ? `Tell ${audience}` : "Send"}</Button>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
}
