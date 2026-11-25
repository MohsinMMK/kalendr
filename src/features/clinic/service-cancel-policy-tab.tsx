"use client";

import { useState } from "react";
import { useWatch } from "react-hook-form";

import { OptionSelect, TextField } from "@/components/form-fields";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { cutoffWords, defaultCancelPolicy, type CancelPolicy } from "@/lib/cancel-policy";

import { errorAt, noticeMinutes, noticeParts, type NoticeUnit } from "./service-editor-model";
import type { ServiceEditorContext } from "./service-editor-tabs";
import { SettingRow } from "./setting-row";

const MAX_CUTOFF_MINUTES = 43_200;
const MAX_REQUEST_DAYS = 60;
const units: { value: NoticeUnit; label: string }[] = [{ value: "minutes", label: "minutes" }, { value: "hours", label: "hours" }, { value: "days", label: "days" }];

/** "Not within [number] [unit] of the start", stored as minutes. The text is kept as typed so a half-typed number is not rewritten. */
function CutoffField({ label, minutes, serverError, onChange, children }: {
  label: string; minutes: number; serverError?: string; onChange: (minutes: number) => void; children?: React.ReactNode;
}) {
  const initial = noticeParts(minutes);
  const [unit, setUnit] = useState<NoticeUnit>(minutes === 0 ? "hours" : initial.unit);
  const [text, setText] = useState(String(Math.round((minutes / noticeMinutes(1, unit)) * 100) / 100));
  const amount = Number(text);
  const total = noticeMinutes(amount, unit);
  const invalid = text.trim() === "" || !Number.isInteger(amount) || amount < 0 || total > MAX_CUTOFF_MINUTES;
  const maxAmount = Math.floor(MAX_CUTOFF_MINUTES / noticeMinutes(1, unit));
  const error = invalid ? `Enter a whole number from 0 to ${maxAmount}.` : serverError;

  function update(nextText: string, nextUnit: NoticeUnit) {
    setText(nextText);
    setUnit(nextUnit);
    const value = Number(nextText);
    // An empty or invalid entry is passed on as NaN, so the form refuses to save it rather than saving something else.
    onChange(nextText.trim() === "" || !Number.isInteger(value) ? Number.NaN : noticeMinutes(value, nextUnit));
  }

  return (
    <Field className="w-full" invalid={Boolean(error)}>
      <FieldLabel>{label}</FieldLabel>
      <div className="grid grid-cols-[1fr_9rem] gap-2">
        <TextField label="Amount" aria-label={`${label} amount`} type="number" inputMode="numeric" min={0} value={text} fieldClassName="[&>div:first-child]:sr-only"
          onChange={(event) => update(event.target.value, unit)} />
        <OptionSelect aria-label={`${label} unit`} value={unit} options={units}
          onValueChange={(next) => update(text, units.find((entry) => entry.value === next)?.value ?? unit)} />
      </div>
      {children ? <FieldDescription>{children}</FieldDescription> : null}
      {error ? <FieldError match>{error}</FieldError> : null}
    </Field>
  );
}

function cutoffSentence(action: "cancel" | "move", minutes: number, t: ServiceEditorContext["terms"]): string {
  const verb = action === "cancel" ? "cancel" : "move their booking";
  if (!Number.isFinite(minutes) || minutes <= 0) return `${t.Customers} can ${verb} any time before the start.`;
  return `${t.Customers} can ${verb} up to ${cutoffWords(minutes)} before the start. After that they see your phone number instead of a ${action === "cancel" ? "Cancel" : "Move"} button.`;
}

/**
 * What a customer may do from their manage link, and how late. It is `ServiceSetup.cancelPolicy` and saves with the
 * editor's normal Save button. Fees and refunds for late cancellations belong to payments, not here.
 */
export function ServiceCancelPolicyTab({ form, terms: t }: Pick<ServiceEditorContext, "form" | "terms">) {
  const watched = useWatch({ control: form.control, name: "cancelPolicy" });
  const policy: CancelPolicy = watched ?? defaultCancelPolicy;
  const { errors } = form.formState;
  const [daysText, setDaysText] = useState(String(policy.rescheduleRequestDays));

  function change(next: Partial<CancelPolicy>) {
    form.setValue("cancelPolicy", { ...policy, ...next }, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
  }

  const days = Number(daysText);
  const daysInvalid = daysText.trim() === "" || !Number.isInteger(days) || days < 1 || days > MAX_REQUEST_DAYS;
  const daysServerError = errorAt(errors, "cancelPolicy.rescheduleRequestDays");
  const daysError = daysInvalid ? `Enter a whole number of days, from 1 to ${MAX_REQUEST_DAYS}.` : daysServerError;

  return (
    <div className="flex flex-col">
      <SettingRow settingId="cancel" title={`${t.Customers} can cancel online`} help={errorAt(errors, "cancelPolicy.allowCustomerCancel")} checked={policy.allowCustomerCancel} onCheckedChange={(next) => change({ allowCustomerCancel: next })}>
        <CutoffField label="Not within this long of the start" minutes={policy.cancelCutoffMinutes} serverError={errorAt(errors, "cancelPolicy.cancelCutoffMinutes")}
          onChange={(minutes) => change({ cancelCutoffMinutes: minutes })}>
          {cutoffSentence("cancel", policy.cancelCutoffMinutes, t)} Late-cancellation fees and refunds are set under payments.
        </CutoffField>
      </SettingRow>

      <SettingRow settingId="reschedule" title={`${t.Customers} can move their booking online`} help={errorAt(errors, "cancelPolicy.allowCustomerReschedule")} checked={policy.allowCustomerReschedule} onCheckedChange={(next) => change({ allowCustomerReschedule: next })}>
        <CutoffField label="Not within this long of the start, to move" minutes={policy.rescheduleCutoffMinutes} serverError={errorAt(errors, "cancelPolicy.rescheduleCutoffMinutes")}
          onChange={(minutes) => change({ rescheduleCutoffMinutes: minutes })}>
          {cutoffSentence("move", policy.rescheduleCutoffMinutes, t)}
        </CutoffField>
      </SettingRow>

      <SettingRow settingId="reschedule" title={`Offer only the same ${t.practitioner}'s times when ${t.aCustomer} moves a booking`}
        help={errorAt(errors, "cancelPolicy.rescheduleSamePerson") ?? `Off means they can pick anyone who offers the ${t.service}.`}
        checked={policy.rescheduleSamePerson} onCheckedChange={(next) => change({ rescheduleSamePerson: next })} />

      <SettingRow settingId="reschedule" title="When you ask them to move" help={`After the days run out the booking is cancelled and ${t.aCustomer} is told.`}>
        <TextField
          label={`Days ${t.aCustomer} has to choose a new time after you ask`}
          error={daysError}
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_REQUEST_DAYS}
          value={daysText}
          onChange={(event) => {
            const text = event.target.value;
            setDaysText(text);
            change({ rescheduleRequestDays: text.trim() === "" ? Number.NaN : Number(text) });
          }}
        />
      </SettingRow>
    </div>
  );
}
