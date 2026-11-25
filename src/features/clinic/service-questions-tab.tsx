"use client";

import { useWatch } from "react-hook-form";

import { SelectField } from "@/components/form-fields";
import { contactModeLabels, contactModes, defaultIntakeSettings, GUESTS_MAX, type ContactMode, type IntakeSettings } from "@/lib/booking-intake";

import { errorAt } from "./service-editor-model";
import type { ServiceEditorContext } from "./service-editor-tabs";
import { SettingRow } from "./setting-row";

const contactHints: Record<ContactMode, string> = {
  email_or_phone: "They give an email, a phone number, or both. We need at least one so we can reach them.",
  email_required: "They must give an email. A phone number is optional.",
  phone_only: "Confirmations go by text or WhatsApp. Those need a messaging account set up in Settings.",
};

const contactOptions = contactModes.map((mode) => ({ value: mode, label: contactModeLabels[mode] }));
const guestOptions = Array.from({ length: GUESTS_MAX }, (_, at) => ({ value: String(at + 1), label: String(at + 1) }));

/**
 * How this service takes contact details, guests and the email check. It is `ServiceSetup.intake` and
 * saves with the editor's normal Save button. A service with none saved uses the defaults.
 */
export function ServiceQuestionsTab({ form, terms: t }: Pick<ServiceEditorContext, "form" | "terms">) {
  const watched = useWatch({ control: form.control, name: "intake" });
  const settings: IntakeSettings = watched ?? defaultIntakeSettings;
  const { errors } = form.formState;
  const phoneOnly = settings.contactMode === "phone_only";

  function change(next: Partial<IntakeSettings>) {
    const merged = { ...settings, ...next };
    // A phone-only service has no email to check.
    if (merged.contactMode === "phone_only") merged.verifyEmail = false;
    form.setValue("intake", merged, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
  }

  return (
    <div className="flex flex-col">
      <SettingRow settingId="intake" title="Contact details" help="What a booking must include so you can reach them.">
        <SelectField
          label="What we ask for"
          hint={contactHints[settings.contactMode]}
          error={errorAt(errors, "intake.contactMode")}
          value={settings.contactMode}
          options={contactOptions}
          onValueChange={(value) => { const mode = contactModes.find((entry) => entry === value); if (mode) change({ contactMode: mode }); }}
        />
      </SettingRow>

      <SettingRow
        settingId="guests"
        title={`Let ${t.customers} add guests`}
        help={errorAt(errors, "intake.allowGuests") ?? "They can add other people to the booking by email. Each guest gets the same confirmation."}
        checked={settings.allowGuests}
        onCheckedChange={(next) => change({ allowGuests: next })}
      >
        <SelectField
          label="Most guests"
          hint={`Up to ${GUESTS_MAX} guests can be added to one booking.`}
          error={errorAt(errors, "intake.maxGuests")}
          value={String(settings.maxGuests)}
          options={guestOptions}
          onValueChange={(value) => change({ maxGuests: Number(value) })}
        />
      </SettingRow>

      <SettingRow
        settingId="verify-email"
        title="Check the email with a code"
        help={errorAt(errors, "intake.verifyEmail") ?? (phoneOnly ? "Not available when the service takes phone numbers only, because there is no email to check." : `${t.Customers} get a 6-digit code by email and enter it before the booking is taken. It stops bookings made with someone else's address.`)}
        checked={settings.verifyEmail && !phoneOnly}
        disabled={phoneOnly}
        onCheckedChange={(next) => change({ verifyEmail: next })}
      />
    </div>
  );
}
