"use client";

import { useTerms } from "@/features/terms/business-profile-context";

import { BookingLimitsPanel } from "./booking-limits-panel";
import type { ServiceEditorContext } from "./service-editor-tabs";
import { SettingRow } from "./setting-row";

/**
 * The service editor's Limits tab. Limits and the customer rules save together with their own Save button,
 * because they are stored apart from the service's settings; the drawer's Save does not touch them.
 */
export function ServiceLimitsTab({ serviceId, onLimitsDirtyChange }: Pick<ServiceEditorContext, "serviceId" | "onLimitsDirtyChange">) {
  const t = useTerms();
  return (
    <SettingRow settingId="limits" title="Limits" help={`This tab has its own Save. It does not wait for the Save at the bottom of the ${t.service} settings.`}>
      <BookingLimitsPanel scope="service" scopeId={serviceId} serviceRules subject={`this ${t.service}`} onDirtyChange={onLimitsDirtyChange} />
    </SettingRow>
  );
}
