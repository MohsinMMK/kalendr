"use client";

import { useWatch } from "react-hook-form";

import { SelectField } from "@/components/form-fields";
import { Checkbox } from "@/components/ui/checkbox";
import { Fieldset, FieldsetLegend } from "@/components/ui/fieldset";
import { Label } from "@/components/ui/label";
import { bookingLayouts, defaultBookingPageSettings, layoutLabels, type BookingLayout, type BookingPageSettings } from "@/lib/booking-page";

import { ServiceAfterBooking } from "./service-after-booking";
import { errorAt } from "./service-editor-model";
import { nestedRow, type ServiceEditorContext } from "./service-editor-tabs";
import { SettingRow } from "./setting-row";

const weekStartOptions = [
  { value: "", label: "Business setting" },
  { value: "1", label: "Monday" },
  { value: "7", label: "Sunday" },
];

/**
 * How this service looks on the booking page: which layouts customers may switch between, which one
 * opens first, whether times are pinned to the business's clock, and the first day of the week.
 * It is part of `ServiceSetup.bookingPage` and saves with the editor's normal Save button.
 */
export function ServicePageTab({ form, terms: t }: Pick<ServiceEditorContext, "form" | "terms">) {
  const watched = useWatch({ control: form.control, name: "bookingPage" });
  const settings: BookingPageSettings = watched ?? defaultBookingPageSettings;
  const { errors } = form.formState;

  function change(next: Partial<BookingPageSettings>) {
    const merged = { ...settings, ...next };
    // The layout shown first must stay one the customer may use.
    if (!merged.layoutsEnabled.includes(merged.defaultLayout)) merged.defaultLayout = merged.layoutsEnabled[0] ?? "month";
    form.setValue("bookingPage", merged, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
  }

  function toggleLayout(layout: BookingLayout, on: boolean) {
    const kept = bookingLayouts.filter((entry) => (entry === layout ? on : settings.layoutsEnabled.includes(entry)));
    if (kept.length === 0) return;
    change({ layoutsEnabled: kept });
  }

  const layoutsError = errorAt(errors, "bookingPage.layoutsEnabled");
  const allowed = bookingLayouts.filter((layout) => settings.layoutsEnabled.includes(layout));
  return (
    <div className="flex flex-col">
      <SettingRow settingId="layouts" title="Booking page layout" help="Which views people can use, which opens first, and the first day of the week.">
        <Fieldset className="max-w-none gap-1" aria-describedby="page-layouts-hint">
          <FieldsetLegend className="font-medium text-sm">Layouts {t.customers} can use</FieldsetLegend>
          <p id="page-layouts-hint" className={layoutsError ? "text-destructive-foreground text-xs" : "text-muted-foreground text-xs"} role={layoutsError ? "alert" : undefined}>
            {layoutsError ?? "They switch between these on the booking page. On a phone the month view is always used."}
          </p>
          <div className="flex flex-col">
            {bookingLayouts.map((layout) => {
              const on = settings.layoutsEnabled.includes(layout);
              return (
                <Label key={layout} className="min-h-11 font-normal">
                  <Checkbox checked={on} disabled={on && settings.layoutsEnabled.length === 1} onCheckedChange={(next) => toggleLayout(layout, next)} />
                  {layoutLabels[layout]}
                </Label>
              );
            })}
          </div>
        </Fieldset>

        <SelectField
          label="Shown first"
          hint="The layout a customer sees when they open the page."
          error={errorAt(errors, "bookingPage.defaultLayout")}
          value={settings.defaultLayout}
          options={allowed.map((layout) => ({ value: layout, label: layoutLabels[layout] }))}
          onValueChange={(value) => { const layout = allowed.find((entry) => entry === value); if (layout) change({ defaultLayout: layout }); }}
        />

        <SelectField
          label="Week starts on"
          hint="For the week and month views. Business setting follows the choice in Settings."
          error={errorAt(errors, "bookingPage.weekStart")}
          value={settings.weekStart === null ? "" : String(settings.weekStart)}
          options={weekStartOptions}
          onValueChange={(value) => change({ weekStart: value === "7" ? 7 : value === "1" ? 1 : null })}
        />
      </SettingRow>

      <SettingRow
        settingId="layouts"
        className={nestedRow}
        title={`Always show times in this ${t.business}'s own time`}
        help={errorAt(errors, "bookingPage.lockTimezone") ?? `For ${t.appointments} that only make sense in local time, like one in person. Customers abroad then see the ${t.location}'s clock.`}
        checked={settings.lockTimezone}
        onCheckedChange={(next) => change({ lockTimezone: next })}
      />
      <ServiceAfterBooking form={form} terms={t} />
      {/* Lane B: rebook-from-old-link field goes here */}
    </div>
  );
}
