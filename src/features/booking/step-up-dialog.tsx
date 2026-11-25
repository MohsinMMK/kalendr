"use client";

import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { OTPField, OTPFieldInput } from "@/components/ui/otp-field";
import { Spinner } from "@/components/ui/spinner";

import { manageRequest, type StepUpAction } from "./manage-step-up";

const codeLength = 6;

/**
 * Asks for the one-time code the server wants before changing a booking from a private link.
 * Mount it only when the server has said so: it sends the code as it opens.
 */
export function StepUpDialog({ bookingApi, action, onVerified, onCancel }: {
  bookingApi: string;
  action: StepUpAction;
  onVerified: () => void;
  onCancel: () => void;
}) {
  const [hint, setHint] = useState("");
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const [sentAgain, setSentAgain] = useState(false);
  const started = useRef(false);

  async function send(again: boolean) {
    setSending(true);
    setError("");
    setSentAgain(false);
    try {
      const result = await manageRequest<{ sent?: boolean; hint?: string }>(`${bookingApi}/step-up`, "POST", { action }, "The code could not be sent.");
      setHint(typeof result?.hint === "string" ? result.hint : "");
      setSentAgain(again);
      setCode("");
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "The code could not be sent.");
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // Sending the code as the dialog opens is the external synchronization this effect performs.
    void send(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verify(value: string) {
    if (value.length < codeLength || verifying) return;
    setVerifying(true);
    setError("");
    try {
      await manageRequest(`${bookingApi}/step-up/verify`, "POST", { code: value }, "That code isn't right.");
      onVerified();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "That code isn't right.");
      setVerifying(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !verifying) onCancel(); }}>
      <DialogPopup>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void verify(code);
          }}
        >
          <DialogHeader>
            <DialogTitle>Enter your code</DialogTitle>
            <DialogDescription>We sent a code to the contact on this booking.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {sending ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Spinner aria-hidden="true" /> Sending your code</p>
            ) : hint && !error ? (
              <p className="text-sm text-muted-foreground" role="status">{sentAgain ? "New code sent to " : "Code sent to "}{hint}</p>
            ) : null}
            {error ? <Alert variant="error" role="alert"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <Field className="gap-2">
              <FieldLabel id="step-up-code-label">Six-digit code</FieldLabel>
              <OTPField
                size="lg"
                length={codeLength}
                autoFocus
                aria-labelledby="step-up-code-label"
                value={code}
                onValueChange={setCode}
                onValueComplete={(value) => void verify(value)}
                disabled={verifying}
              >
                {Array.from({ length: codeLength }, (_, index) => <OTPFieldInput key={index} {...(index === 0 ? {} : { "aria-label": `Digit ${index + 1}` })} />)}
              </OTPField>
            </Field>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={sending || verifying} onClick={() => void send(true)}>Send a new code</Button>
            <Button type="button" variant="ghost" disabled={verifying} onClick={onCancel}>Cancel</Button>
            <Button type="submit" loading={verifying} disabled={code.length < codeLength}>Continue</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
