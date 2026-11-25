"use client";

import { useEffect, useState } from "react";
import { useWatch } from "react-hook-form";

import { SelectField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useTerms } from "@/features/terms/business-profile-context";
import type { Schedule } from "@/lib/availability-setup";

import { listSchedules } from "./availability-api";
import type { ServiceEditorContext } from "./service-editor-tabs";
import { SettingRow } from "./setting-row";

export interface ServiceHoursValue {
  scheduleId: string | null;
  restrictionScheduleId: string | null;
}

/** The schedule names on offer. People with the same name share one choice: "Home visits" means each person's own "Home visits". */
export function scheduleChoices(schedules: readonly Schedule[]): Array<{ value: string; label: string }> {
  const byName = new Map<string, string>();
  for (const schedule of schedules) if (!byName.has(schedule.name)) byName.set(schedule.name, schedule.id);
  return [...byName].map(([name, id]) => ({ value: id, label: name }));
}

/**
 * Which hours a service follows. "Use this schedule" replaces each person's default for this service,
 * and "Only offer times inside" narrows everyone's hours to the overlap with another schedule.
 * Both choices are part of `ServiceSetup.basics` and save with the editor's normal Save button.
 */
export function ServiceHoursPanel({ practitionerIds, value, onChange, supported }: {
  practitionerIds: readonly string[];
  value: ServiceHoursValue;
  onChange?: (next: ServiceHoursValue) => void;
  supported: boolean;
}) {
  const t = useTerms();
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [failed, setFailed] = useState(false);
  const key = practitionerIds.join(",");

  useEffect(() => {
    const controller = new AbortController();
    Promise.all(key.split(",").filter(Boolean).map((id) => listSchedules(id, controller.signal))).then((lists) => {
      if (!controller.signal.aborted) setSchedules(lists.flat());
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => controller.abort();
  }, [key]);

  const choices = scheduleChoices(schedules ?? []);
  const options = [{ value: "", label: `Each ${t.provider}'s usual hours` }, ...choices];
  const restrict = [{ value: "", label: "No limit" }, ...choices];
  const loading = !supported || schedules === null;
  const usual = `Each ${t.provider}'s usual hours`;
  return (
    <div className="flex flex-col">
      {!supported ? <Alert variant="info" className="mb-3"><AlertDescription>Choosing hours for a {t.service} is not saved yet. These lists show what will be offered once it is.</AlertDescription></Alert> : null}
      {failed ? <Alert variant="error" className="mb-3"><AlertDescription>Schedules could not be loaded.</AlertDescription></Alert> : null}
      {/* An empty schedule means the business's usual hours: each person's own default, so Reset writes null. */}
      <SettingRow
        settingId="hours"
        title="Hours for this one"
        help={`Use a schedule of its own for this ${t.service}, instead of the usual hours.`}
        businessDefault={{
          inherited: value.scheduleId === null,
          summary: usual,
          onCustomize: () => { const first = choices[0]; if (first) onChange?.({ ...value, scheduleId: first.value }); },
          onReset: () => onChange?.({ ...value, scheduleId: null }),
        }}
        disabled={loading || (value.scheduleId === null && choices.length === 0)}
      >
        <SelectField label="Use this schedule" hint={`For this ${t.service} only. A ${t.provider} without a schedule of that name keeps their usual hours.`} value={value.scheduleId ?? ""} options={options} disabled={loading} onValueChange={(next) => onChange?.({ ...value, scheduleId: next || null })} />
      </SettingRow>
      <SettingRow settingId="hours" title="Limit to another schedule" help={`Narrows everyone's hours for this ${t.service} to the overlap with another schedule, for example "Tuesday afternoons".`}>
        <SelectField label="Only offer times inside" hint="Pick No limit to turn this off." value={value.restrictionScheduleId ?? ""} options={restrict} disabled={loading} onValueChange={(next) => onChange?.({ ...value, restrictionScheduleId: next || null })} />
      </SettingRow>
    </div>
  );
}

export function ServiceHoursTab({ practitioners, form, saves }: Pick<ServiceEditorContext, "practitioners" | "form" | "saves">) {
  const scheduleId = useWatch({ control: form.control, name: "basics.scheduleId" });
  const restrictionScheduleId = useWatch({ control: form.control, name: "basics.restrictionScheduleId" });
  return (
    <ServiceHoursPanel
      practitionerIds={practitioners.map((person) => person.id)}
      value={{ scheduleId: scheduleId ?? null, restrictionScheduleId: restrictionScheduleId ?? null }}
      supported={saves}
      onChange={(next) => {
        form.setValue("basics.scheduleId", next.scheduleId, { shouldDirty: true });
        form.setValue("basics.restrictionScheduleId", next.restrictionScheduleId, { shouldDirty: true });
      }}
    />
  );
}
