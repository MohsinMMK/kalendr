"use client";

import { CircleCheck } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { OTPField, OTPFieldInput } from "@/components/ui/otp-field";

import type { EmailCheck } from "../use-email-check";

const CODE_LENGTH = 6;
const slots = Array.from({ length: CODE_LENGTH }, (_, index) => index);

/**
 * "Email check": send a 6-digit code to the customer's email and take it back. Shown under the email field of a
 * service that wants the address confirmed before it books.
 */
export function EmailCheckBlock({ email, check }: { email: string; check: EmailCheck }) {
  const [code, setCode] = useState("");
  const { phase, message, locked } = check;
  const asking = phase === "sent" || phase === "verifying";

  // A new code or a wrong one starts with empty boxes.
  const [seen, setSeen] = useState({ phase, message });
  if (seen.phase !== phase || seen.message !== message) {
    setSeen({ phase, message });
    if (phase === "idle" || phase === "sending" || (phase === "sent" && message?.tone === "error")) setCode("");
  }

  if (phase === "verified") {
    return (
      <div id="email-check" tabIndex={-1} role="status" className="col-span-2 flex items-center gap-2 rounded-xl border border-success/32 bg-success/4 p-3.5 text-sm outline-none">
        <CircleCheck aria-hidden="true" className="size-5 shrink-0 text-success-foreground" />
        <span className="min-w-0 wrap-break-word">
          <span className="font-medium">Email confirmed</span>
          <span className="text-muted-foreground"> · {email.trim()}</span>
        </span>
      </div>
    );
  }

  const sendLabel = asking ? "Send a new code" : "Send me a code";
  const waiting = check.secondsToResend > 0;
  return (
    <section
      id="email-check"
      tabIndex={-1}
      aria-labelledby="email-check-title"
      className="col-span-2 flex flex-col gap-3 rounded-xl border bg-card p-3.5 outline-none sm:p-4"
    >
      <div className="flex flex-col gap-0.5">
        <h2 id="email-check-title" className="font-medium text-sm">Email check</h2>
        <p className="text-muted-foreground text-xs">
          {asking ? "Enter the 6 digits from the email." : "We send a 6-digit code to this address to make sure it is yours."}
        </p>
      </div>

      {asking ? (
        <Field className="gap-2">
          <FieldLabel>6-digit code</FieldLabel>
          <OTPField
            length={CODE_LENGTH}
            size="lg"
            value={code}
            disabled={phase === "verifying" || locked}
            onValueChange={(next) => setCode(next)}
            onValueComplete={(next) => void check.verify(next)}
            className="gap-1.5 sm:gap-2"
          >
            {slots.map((slot) => (
              <OTPFieldInput
                key={slot}
                // The first box is named by the label above; the others by their place.
                {...(slot === 0 ? {} : { "aria-label": `Digit ${slot + 1} of ${CODE_LENGTH}` })}
                aria-invalid={message?.tone === "error" || undefined}
                className="size-11 sm:size-11"
              />
            ))}
          </OTPField>
        </Field>
      ) : null}

      {message ? (
        <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "font-medium text-destructive-foreground text-sm" : "text-muted-foreground text-sm"}>
          {message.text}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {asking ? (
          <Button type="button" size="lg" disabled={code.length !== CODE_LENGTH || phase === "verifying" || locked} loading={phase === "verifying"} onClick={() => void check.verify(code)}>
            Confirm code
          </Button>
        ) : null}
        <Button
          type="button"
          size="lg"
          variant={asking ? "ghost" : "default"}
          loading={phase === "sending"}
          disabled={phase === "sending" || phase === "verifying" || (asking && waiting && !locked)}
          onClick={() => void check.send()}
        >
          {sendLabel}
        </Button>
        {asking && waiting && !locked ? (
          <span className="text-muted-foreground text-xs tabular-nums">You can ask again in {check.secondsToResend} s</span>
        ) : null}
      </div>
    </section>
  );
}
