"use client";

import { useState } from "react";

import { TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";

import { ManageRequestError, manageRequest } from "./manage-step-up";

/** Lets someone change the phone or email on a booking. Mount it when open. */
export function ChangeContactDialog({ bookingApi, hidden, onClose, onNeedsCode, onSaved }: {
  bookingApi: string;
  /** True while the one-time code dialog is on top. */
  hidden: boolean;
  onClose: () => void;
  onNeedsCode: (retry: () => Promise<void>) => void;
  onSaved: () => void;
}) {
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function save(afterCode: boolean) {
    const body = { ...(phone.trim() ? { phone: phone.trim() } : {}), ...(email.trim() ? { email: email.trim() } : {}) };
    if (!body.phone && !body.email) {
      setError("Enter a new phone number or email.");
      return;
    }
    setPending(true);
    setError("");
    try {
      await manageRequest(`${bookingApi}/contact`, "PATCH", body, "Your contact details could not be changed.");
      onSaved();
    } catch (cause: unknown) {
      if (cause instanceof ManageRequestError && cause.code === "step_up_required" && !afterCode) {
        onNeedsCode(() => save(true));
      } else {
        setError(cause instanceof Error ? cause.message : "Your contact details could not be changed.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={!hidden} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogPopup>
        <Form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void save(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>Change contact details</DialogTitle>
            <DialogDescription>We will also tell you on your other contact that this changed.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {error ? <Alert variant="error" role="alert"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <TextField id="contact-phone" label="New phone number" type="tel" autoComplete="tel" optional value={phone} onChange={(event) => setPhone(event.target.value)} />
            <TextField id="contact-email" label="New email" type="email" autoComplete="email" optional value={email} onChange={(event) => setEmail(event.target.value)} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={pending}>Save</Button>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
}
