"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { toastManager } from "@/components/ui/toast";
import { appleConnectInputSchema } from "@/lib/calendar-sync";

import { touchTarget } from "./calendar-confirm";
import { useConnectApple } from "./queries/calendars";

type FieldErrors = { appleId?: string; appPassword?: string };

/**
 * Apple has no sign-in screen to send people to, so they paste an app-specific password here.
 * It is checked on this screen first, and again by the server, which shows its own answer beside the password.
 */
export function AppleConnectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const connect = useConnectApple();
  const [errors, setErrors] = useState<FieldErrors>({});

  function change(next: boolean) {
    if (!next) {
      setErrors({});
      connect.reset();
    }
    onOpenChange(next);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = appleConnectInputSchema.safeParse({ appleId: data.get("appleId"), appPassword: data.get("appPassword") });
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] === "appleId" ? "appleId" : "appPassword";
        next[key] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    connect.mutate(parsed.data, {
      onSuccess: () => {
        toastManager.add({ title: "Apple Calendar is being checked", description: "This takes a few seconds.", type: "success" });
        change(false);
      },
      onError: (error) => setErrors({ appPassword: error.message }),
    });
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogPopup className="sm:max-w-md">
        <Form errors={errors} onSubmit={submit} className="flex min-h-0 flex-col" aria-label="Connect Apple Calendar">
          <DialogHeader>
            <DialogTitle>Connect Apple Calendar</DialogTitle>
            <DialogDescription>Use an app-specific password. Never type your normal Apple password here.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <Field name="appleId">
              <FieldLabel>Apple ID email</FieldLabel>
              <Input name="appleId" type="email" autoComplete="off" inputMode="email" size="lg" placeholder="you@icloud.com" />
              <FieldError />
            </Field>
            <Field name="appPassword">
              <FieldLabel>App-specific password</FieldLabel>
              <Input name="appPassword" type="password" autoComplete="off" size="lg" placeholder="abcd-efgh-ijkl-mnop" />
              <FieldDescription>
                Make one at account.apple.com: Sign-In and Security, then App-Specific Passwords. It lets Kalendr read and write your calendar and nothing else, and you can switch it off there at any time.
              </FieldDescription>
              <FieldError />
            </Field>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" className={touchTarget} />}>Cancel</DialogClose>
            <Button type="submit" className={touchTarget} loading={connect.isPending}>Connect</Button>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
}
