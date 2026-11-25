"use client";

import { useWatch } from "react-hook-form";

import { SelectField, TextareaField, TextField } from "@/components/form-fields";
import { afterBookingLabels, afterBookingModes, defaultAfterBooking, type AfterBookingMode, type AfterBookingSettings } from "@/lib/after-booking";

import { errorAt } from "./service-editor-model";
import { nestedRow, type ServiceEditorContext } from "./service-editor-tabs";
import { SettingRow } from "./setting-row";

/**
 * What the customer sees after booking this service (feature 52): Kalendr's confirmation with an optional message of your own
 * (and optionally without the details), or your own thank-you page. It is `ServiceSetup.afterBooking` and saves with the editor.
 */
export function ServiceAfterBooking({ form, terms: t }: Pick<ServiceEditorContext, "form" | "terms">) {
  const watched = useWatch({ control: form.control, name: "afterBooking" });
  const settings: AfterBookingSettings = watched ?? defaultAfterBooking;
  const { errors } = form.formState;

  function change(next: Partial<AfterBookingSettings>) {
    form.setValue("afterBooking", { ...settings, ...next }, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
  }

  return (
    <>
      <SettingRow settingId="after-booking" title={`After ${t.aCustomer} books`} help={`What they see the moment the ${t.appointment} is made.`}>
        <SelectField
          label="Then"
          hint={afterBookingLabels[settings.mode].description}
          error={errorAt(errors, "afterBooking.mode")}
          value={settings.mode}
          options={afterBookingModes.map((mode) => ({ value: mode, label: afterBookingLabels[mode].label }))}
          onValueChange={(value) => { const mode = afterBookingModes.find((entry): entry is AfterBookingMode => entry === value); if (mode) change({ mode }); }}
        />
        {settings.mode === "redirect" ? (
          <TextField
            label="Thank-you page address"
            type="url"
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="https://www.example.com/thanks"
            hint="Customers go here as soon as they book. The booking id is added to the address."
            error={errorAt(errors, "afterBooking.redirectUrl")}
            value={settings.redirectUrl ?? ""}
            maxLength={500}
            onChange={(event) => change({ redirectUrl: event.target.value.trim() === "" ? null : event.target.value })}
          />
        ) : (
          <TextareaField
            label="Message on the confirmation"
            optional
            hint={`Shown under “You’re booked”, for example parking or what to bring.`}
            error={errorAt(errors, "afterBooking.successMessage")}
            value={settings.successMessage ?? ""}
            maxLength={500}
            rows={3}
            onChange={(event) => change({ successMessage: event.target.value === "" ? null : event.target.value })}
          />
        )}
      </SettingRow>
      {settings.mode === "redirect" ? (
        <SettingRow settingId="after-booking" className={nestedRow} title="Also pass the service and time" help="Adds the service, start time and a signed summary that lasts 15 minutes. Never a name, email or phone number."
          checked={settings.passDetailsOnRedirect} onCheckedChange={(next) => change({ passDetailsOnRedirect: next })} />
      ) : (
        <SettingRow settingId="after-booking" className={nestedRow} title={`Hide the ${t.appointment} details`} help="Shows only the thank-you and the manage button. For a website that already shows the details itself."
          checked={settings.hideSuccessDetails} onCheckedChange={(next) => change({ hideSuccessDetails: next })} />
      )}
    </>
  );
}
