"use client";

import { useState } from "react";
import { useWatch } from "react-hook-form";

import { SelectField, TextField } from "@/components/form-fields";
import {
  APPROVAL_NOTICE_MAX_HOURS, approvalRuleHints, approvalRuleLabels, approvalRules, approvalSummary, defaultApprovalSettings,
  type ApprovalSettings,
} from "@/lib/approval";

import { errorAt } from "./service-editor-model";
import { nestedRow, type ServiceEditorContext } from "./service-editor-tabs";
import { SettingRow } from "./setting-row";

const ruleOptions = approvalRules.map((rule) => ({ value: rule, label: approvalRuleLabels[rule] }));
const hoursProblem = `Enter a whole number of hours, from 1 to ${APPROVAL_NOTICE_MAX_HOURS}.`;

/**
 * Which bookings wait for staff to approve them. It is `ServiceSetup.approval` and saves with the editor's
 * normal Save button. The booking mode on the Basics tab is kept in step by the server.
 */
export function ServiceApprovalTab({ form, terms: t }: Pick<ServiceEditorContext, "form" | "terms">) {
  const watched = useWatch({ control: form.control, name: "approval" });
  const settings: ApprovalSettings = watched ?? defaultApprovalSettings;
  const { errors } = form.formState;
  const [hoursText, setHoursText] = useState(String(settings.noticeHours));
  const needsApproval = settings.rule !== "never";

  function change(next: Partial<ApprovalSettings>) {
    form.setValue("approval", { ...settings, ...next }, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
  }

  const hoursValue = Number(hoursText);
  const hoursInvalid = !Number.isInteger(hoursValue) || hoursValue < 1 || hoursValue > APPROVAL_NOTICE_MAX_HOURS;
  const hoursError = errorAt(errors, "approval.noticeHours") ? (hoursInvalid ? hoursProblem : errorAt(errors, "approval.noticeHours")) : undefined;

  return (
    <div className="flex flex-col">
      <SettingRow settingId="approval" title="Approval" help="Whether a booking waits for you before it is confirmed.">
        <SelectField
          label="Does a booking need your approval?"
          hint={approvalRuleHints[settings.rule]}
          error={errorAt(errors, "approval.rule")}
          value={settings.rule}
          options={ruleOptions}
          onValueChange={(value) => { const rule = approvalRules.find((entry) => entry === value); if (!rule) return;
            // Leaving the hours field with junk in it would block saving with nothing to see, so restore the default.
            if (rule !== "short_notice" && !Number.isInteger(settings.noticeHours)) { setHoursText(String(defaultApprovalSettings.noticeHours)); change({ rule, noticeHours: defaultApprovalSettings.noticeHours }); return; }
            change({ rule }); }}
        />
        {settings.rule === "short_notice" ? (
          <TextField
            label="Within how many hours of the start?"
            hint={`A booking made this close to the start waits for you. ${t.Customers} can book later times at once.`}
            error={hoursError}
            type="number"
            inputMode="numeric"
            min={1}
            max={APPROVAL_NOTICE_MAX_HOURS}
            value={hoursText}
            onChange={(event) => {
              const text = event.target.value;
              setHoursText(text);
              const hours = Number(text);
              // An empty or invalid entry is kept as typed, so the person can fix it; the form refuses to save it.
              change({ noticeHours: text.trim() === "" ? Number.NaN : hours });
            }}
          />
        ) : null}
        <p className="text-muted-foreground text-xs">{approvalSummary(settings)}</p>
      </SettingRow>
      {needsApproval ? (
        <>
          <SettingRow
            settingId="approval"
            className={nestedRow}
            title="Waiting requests keep their time"
            help={errorAt(errors, "approval.requestsHoldSlot") ?? "When this is off, the time stays open for other customers. If someone takes it before you approve, you will be asked to choose another time."}
            checked={settings.requestsHoldSlot}
            onCheckedChange={(next) => change({ requestsHoldSlot: next })}
          />
          <SettingRow
            settingId="approval"
            className={nestedRow}
            title="Hide the address until approved"
            help={errorAt(errors, "approval.hideLocationUntilConfirmed") ?? "The confirmation and manage page leave out the address or call details until you approve."}
            checked={settings.hideLocationUntilConfirmed}
            onCheckedChange={(next) => change({ hideLocationUntilConfirmed: next })}
          />
        </>
      ) : null}
    </div>
  );
}
