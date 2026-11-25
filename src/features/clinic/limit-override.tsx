"use client";

import { TriangleAlert } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { OptionSelect } from "@/components/form-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { limitOverrideLabels, limitOverrideReasons, type LimitOverrideReason } from "@/lib/booking-limits";

import { StaffApiError } from "./queries/http";

/** The codes the server answers a booking or move with when a limit is full. */
export const limitErrorCodes = ["limit_reached", "customer_cap_reached", "outside_booking_rules"] as const;

export function isLimitError(cause: unknown): cause is StaffApiError {
  return cause instanceof StaffApiError && cause.status === 409 && (limitErrorCodes as readonly string[]).includes(cause.code);
}

export function limitOverrideReasonOf(value: string): LimitOverrideReason | null {
  return limitOverrideReasons.find((reason) => reason === value) ?? null;
}

interface Hit { code: string; message: string; key: string }

/**
 * Staff may go past a booking limit, but only by choosing one of a fixed list of reasons.
 * A flow calls `capture(cause)` where it handles a refusal, spreads `takeBody()` into its request, and renders
 * {@link LimitOverridePrompt}. `resetKey` names what is being booked: change the time and the question goes away,
 * so an answer given for one time is never used for another.
 */
export function useLimitOverride(resetKey: string) {
  const [hit, setHit] = useState<Hit | null>(null);
  const [reason, setReason] = useState<LimitOverrideReason | "">("");
  const armed = useRef<LimitOverrideReason | null>(null);
  const active = hit && hit.key === resetKey ? hit : null;

  /** True when the refusal was a full limit, which the prompt now explains. Any other refusal clears the prompt. */
  const capture = useCallback((cause: unknown): boolean => {
    armed.current = null;
    if (isLimitError(cause)) {
      setHit({ code: cause.code, message: cause.message, key: resetKey });
      return true;
    }
    setHit(null);
    return false;
  }, [resetKey]);

  const clear = useCallback(() => { armed.current = null; setHit(null); setReason(""); }, []);

  /** Arms the chosen reason for the next request only, then runs it. */
  const confirm = useCallback((run: () => void) => {
    if (!reason) return;
    armed.current = reason;
    run();
  }, [reason]);

  /** The field to add to a request body. Only the request that follows a confirm carries it. */
  const takeBody = useCallback((): { limitOverrideReason?: LimitOverrideReason } => {
    const taken = armed.current;
    armed.current = null;
    return taken ? { limitOverrideReason: taken } : {};
  }, []);

  return { hit: active, reason, setReason, capture, clear, confirm, takeBody };
}

export type LimitOverride = ReturnType<typeof useLimitOverride>;

/** The warning that explains a full limit and lets staff go past it with a reason. Shows nothing otherwise. */
export function LimitOverridePrompt({ override, actionLabel, pending = false, onConfirm, className }: {
  override: LimitOverride;
  /** "Book anyway" or "Move anyway". */
  actionLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  className?: string;
}) {
  const { hit } = override;
  if (!hit) return null;
  return (
    <Alert variant="warning" className={className}>
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{hit.code === "customer_cap_reached" ? "This customer is at their limit" : hit.code === "outside_booking_rules" ? "This time is outside your booking rules" : "This time is over a limit"}</AlertTitle>
      <AlertDescription>
        <p>{hit.message}</p>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field className="w-full sm:max-w-72">
            <FieldLabel>Why go past it?</FieldLabel>
            <OptionSelect aria-label="Why go past it?" value={override.reason} placeholder="Choose a reason" disabled={pending}
              options={limitOverrideReasons.map((reason) => ({ value: reason, label: limitOverrideLabels[reason] }))}
              onValueChange={(next) => override.setReason(limitOverrideReasonOf(next) ?? "")} />
          </Field>
          <Button type="button" size="lg" className="min-h-11" disabled={!override.reason || pending} onClick={() => override.confirm(onConfirm)}>
            {pending ? <Spinner aria-hidden="true" /> : null}
            {actionLabel}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
