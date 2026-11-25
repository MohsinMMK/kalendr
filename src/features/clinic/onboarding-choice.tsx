"use client";

import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, CircleCheck } from "lucide-react";

import { TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Fieldset } from "@/components/ui/fieldset";
import { Label } from "@/components/ui/label";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import { Radio } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { BookingBottomBar } from "@/features/booking/booking-bottom-bar";
import { BookingProgress } from "@/features/booking/booking-progress";
import { cn } from "@/lib/utils";

/** How long a tapped choice stays on screen before the next one, as in the booking flow. */
export const tapAdvanceDelayMs = 180;

/**
 * The owner's sign-up and setup frame: the same progress bar and bottom bar as
 * the customer's booking, with the chapter named above the bar.
 */
export function OnboardingFrame({
  chapter,
  stepNumber,
  stepCount,
  progress,
  wide,
  preview = false,
  signedIn = false,
  aside,
  children,
}: {
  /** "Your business", "What you offer" or "When you're open". */
  chapter?: string;
  /** Leave out on the closing screens, which have no progress. */
  stepNumber?: number;
  stepCount?: number;
  /** Replaces the "Step n of m" bar, for a screen that shows its own steps. */
  progress?: ReactNode;
  wide?: boolean;
  preview?: boolean;
  /** The owner already has an account, so setup is saving as they go. */
  signedIn?: boolean;
  /** A panel shown beside the steps on large screens (sign-up shows what the owner gets). */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const frame = (
    <div className="flex min-h-dvh min-w-0 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/"
            className="font-heading text-lg font-semibold text-foreground no-underline"
          >
            kalendr
          </Link>
          {preview ? <Badge variant="outline">Preview</Badge> : null}
        </div>
        {signedIn ? null : (
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden text-sm text-muted-foreground sm:inline">Already have an account?</span>
            <Button variant="outline" size="sm" render={<Link href="/sign-in" />}>
              Sign in
            </Button>
          </div>
        )}
      </header>
      <main
        id="main-content"
        className={cn(
          "mx-auto flex w-full min-w-0 flex-1 flex-col gap-5 overflow-x-clip px-4 py-6 max-md:pb-28 sm:px-6 lg:py-10",
          wide ? "max-w-4xl" : "max-w-2xl",
        )}
      >
        {chapter || stepNumber ? (
          <div className="flex flex-col gap-2">
            {chapter ? (
              <p className="text-xs font-semibold tracking-wide text-primary uppercase">
                {chapter}
              </p>
            ) : null}
            {progress ?? (stepNumber && stepCount ? (
              <BookingProgress current={stepNumber} total={stepCount} />
            ) : null)}
          </div>
        ) : null}
        {children}
        <div className="flex flex-col gap-1 border-t pt-4 text-xs text-muted-foreground md:mb-0">
          <p>
            {preview
              ? "Preview only. Use example details; no account or live booking page is created."
              : signedIn
                ? "Each step saves as you go."
                : "Account details stay in this form until you create your account. Setup then saves as you go."}
          </p>
          <Button
            variant="link"
            size="sm"
            className="h-auto self-start px-0 font-normal text-muted-foreground sm:h-auto"
            render={<Link href="/#questions" />}
          >
            Setup questions
          </Button>
        </div>
      </main>
    </div>
  );
  if (!aside) return frame;
  return (
    <div className="bg-background lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {frame}
      <aside aria-label="What you get" className="hidden p-3 lg:block">
        <div className="sticky top-3 h-[calc(100dvh-1.5rem)]">{aside}</div>
      </aside>
    </div>
  );
}

/**
 * One question per screen. The heading takes focus whenever `stepKey` changes;
 * Enter submits; Back and the main action sit in the booking flow's bottom bar.
 */
export function OnboardingStep({
  title,
  stepKey,
  detail,
  children,
  error,
  onBack,
  onContinue,
  continueLabel = "Continue",
  continueDisabled,
  pending,
  hideContinue,
}: {
  title: string;
  stepKey?: string;
  detail: ReactNode;
  children: ReactNode;
  error?: string;
  onBack?: () => void;
  onContinue?: () => void;
  continueLabel?: string;
  continueDisabled?: boolean;
  pending?: boolean;
  hideContinue?: boolean;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const focusKey = stepKey ?? title;
  useEffect(() => {
    titleRef.current?.focus();
  }, [focusKey]);

  return (
    <form
      className="flex min-w-0 flex-col gap-5"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        if (!continueDisabled && !pending) onContinue?.();
      }}
    >
      {/* Only the content moves; a transformed parent would pin the fixed bottom bar inside it. */}
      <div
        key={focusKey}
        className="flex min-w-0 flex-col gap-5 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-3 motion-safe:duration-200"
      >
        <div className="flex flex-col gap-1">
          <h1
            ref={titleRef}
            id={titleId}
            tabIndex={-1}
            data-step-heading
            className="font-heading text-xl font-semibold outline-none sm:text-2xl"
          >
            {title}
          </h1>
          <p className="max-w-prose text-sm text-muted-foreground">{detail}</p>
        </div>
        <Fieldset
          disabled={pending}
          aria-labelledby={titleId}
          className="grid min-w-0 gap-4"
        >
          {children}
        </Fieldset>
        {error ? (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      {onBack || !hideContinue ? (
        <BookingBottomBar onBack={onBack} backDisabled={pending}>
          {hideContinue ? (
            <span aria-hidden="true" />
          ) : (
            <Button
              type="submit"
              size="lg"
              disabled={continueDisabled || pending}
              aria-busy={pending}
            >
              {pending ? <Spinner aria-hidden="true" /> : null}
              {pending ? "Saving…" : continueLabel}
              {pending ? null : <ArrowRight aria-hidden="true" />}
            </Button>
          )}
        </BookingBottomBar>
      ) : null}
    </form>
  );
}

/**
 * A whole-card choice inside a coss `RadioGroup` (the `p-radio-group-6`
 * pattern): the radio is hidden and the card shows the choice. `tile` stacks a
 * large icon over the words; `row` reads left to right.
 */
export function ChoiceCard({
  value,
  title,
  detail,
  icon,
  layout = "row",
  onPick,
}: {
  value: string;
  title: string;
  detail?: string;
  icon?: ReactNode;
  layout?: "row" | "tile";
  /** Pointer taps report `detail` above 0; keyboard choices report 0. */
  onPick?: (event: MouseEvent<HTMLLabelElement>) => void;
}) {
  const tile = layout === "tile";
  return (
    <Label
      onClick={onPick}
      className={cn(
        "group relative flex w-full min-w-0 cursor-pointer rounded-xl border bg-card p-3.5 font-normal transition-colors hover:bg-accent/40 has-focus-visible:ring-2 has-focus-visible:ring-ring has-data-checked:border-primary/48 has-data-checked:bg-accent/50 has-data-checked:ring-2 has-data-checked:ring-primary/48",
        tile ? "min-h-32 flex-col items-start gap-2" : "min-h-14 items-start gap-3",
      )}
    >
      <span className="sr-only">
        <Radio value={value} />
      </span>
      {icon ? (
        <span
          className={cn(
            "flex shrink-0 items-center justify-center text-foreground",
            tile ? "size-10 rounded-lg bg-accent [&_svg]:size-6" : "mt-0.5 [&_svg]:size-5",
          )}
          aria-hidden="true"
        >
          {icon}
        </span>
      ) : null}
      <span className={cn("flex min-w-0 flex-col gap-0.5", tile ? "pe-5" : "flex-1")}>
        <span className="text-sm font-medium text-foreground">{title}</span>
        {detail ? (
          <span className="text-xs text-muted-foreground">{detail}</span>
        ) : null}
      </span>
      <CircleCheck
        className={cn(
          "hidden size-5 shrink-0 text-primary group-has-data-checked:block",
          tile ? "absolute end-3 top-3" : "mt-0.5",
        )}
        aria-hidden="true"
      />
    </Label>
  );
}

/** A labelled on/off choice with its explanation, the coss switch row. */
export function SwitchRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border bg-card p-3.5">
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={id}>{label}</Label>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/** A labelled stepper for whole minutes, backed by the string state the forms already keep. */
export function MinutesField({
  id,
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step = 5,
  size = "lg",
  className,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  step?: number;
  size?: "sm" | "default" | "lg";
  className?: string;
}) {
  return (
    <Field className={cn("w-full", className)}>
      <FieldLabel>{label}</FieldLabel>
      <NumberField
        id={id}
        size={size}
        min={min}
        max={max}
        step={step}
        value={value === "" || Number.isNaN(Number(value)) ? null : Number(value)}
        onValueChange={(next) => onChange(next === null ? "" : String(next))}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement />
          <NumberFieldInput />
          <NumberFieldIncrement />
        </NumberFieldGroup>
      </NumberField>
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}

export function TypeInField({
  id,
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  placeholder,
  hint,
  error,
  autoFocus,
  required,
  maxLength,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
  hint?: string;
  error?: string;
  autoFocus?: boolean;
  required?: boolean;
  maxLength?: number;
}) {
  return (
    <TextField
      label={label}
      id={id}
      type={type}
      value={value}
      autoFocus={autoFocus}
      autoComplete={autoComplete}
      placeholder={placeholder}
      hint={hint}
      error={error}
      required={required}
      maxLength={maxLength}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
