"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { OptionSelect } from "@/components/form-fields";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import type { TaxTreatment } from "@/lib/gst";
import type { TaxSettingsView } from "@/lib/invoicing-contracts";
import { formatMoney } from "@/lib/money";

import { invoiceKeys } from "./queries/invoicing";
import { staffMutation } from "./queries/http";

type ServiceRow = TaxSettingsView["services"][number];

const presetRates = [500, 1200, 1800, 2800];
const percent = (bps: number) => `${bps / 100}%`;

export function treatmentLabel(treatment: TaxTreatment, rateBps: number): string {
  return treatment === "taxable" ? `Taxable at ${percent(rateBps)}` : treatment === "exempt" ? "Exempt from GST" : "Nil rated (no GST)";
}

const encode = (row: ServiceRow) => (row.treatment ? (row.treatment === "taxable" ? `taxable:${row.rateBps ?? 0}` : row.treatment) : "default");

function optionsFor(row: ServiceRow, defaultText: string) {
  const options = [
    { value: "default", label: `Use the default (${defaultText})` },
    ...presetRates.map((rate) => ({ value: `taxable:${rate}`, label: `Taxable at ${percent(rate)}` })),
    { value: "exempt", label: "Exempt from GST" },
    { value: "nil", label: "Nil rated (no GST)" },
  ];
  // A rate saved earlier that is not one of the usual ones stays choosable.
  const saved = encode(row);
  if (!options.some((option) => option.value === saved)) options.splice(1, 0, { value: saved, label: treatmentLabel("taxable", row.rateBps ?? 0) });
  return options;
}

/** Each service can be taxed differently from the business default. A change is saved as soon as it is chosen. */
export function TaxServiceRules({ settings, canEdit }: { settings: TaxSettingsView; canEdit: boolean }) {
  const t = useTerms();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const defaultText = treatmentLabel(settings.defaultTreatment, settings.defaultRateBps);

  async function choose(row: ServiceRow, value: string) {
    if (value === encode(row)) return;
    setBusy(row.serviceId);
    setErrors((current) => ({ ...current, [row.serviceId]: "" }));
    try {
      let next: TaxSettingsView;
      if (value === "default") {
        next = await staffMutation<TaxSettingsView>("/api/staff/tax-settings/services", "DELETE", { serviceId: row.serviceId });
      } else {
        const [treatment, rate] = value.split(":") as [TaxTreatment, string | undefined];
        next = await staffMutation<TaxSettingsView>("/api/staff/tax-settings/services", "PUT", {
          serviceId: row.serviceId, treatment, rateBps: treatment === "taxable" ? Number(rate) : 0, ...(row.sacCode ? { sacCode: row.sacCode } : {}),
        });
      }
      queryClient.setQueryData(invoiceKeys.taxSettings(), next);
      toastManager.add({ title: `Saved for ${row.name}`, type: "success" });
    } catch (cause: unknown) {
      setErrors((current) => ({ ...current, [row.serviceId]: cause instanceof Error ? cause.message : "Could not save. Try again." }));
    } finally {
      setBusy(null);
    }
  }

  if (!settings.services.length) return <p className="text-muted-foreground text-sm">There are no {t.services} yet. Add some and you can set tax for each here.</p>;
  return (
    <ul aria-label={`Tax for each ${t.service}`} className="flex flex-col divide-y rounded-lg border">
      {settings.services.map((row) => (
        <li key={row.serviceId} className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="truncate font-medium text-sm">{row.name}</p>
            <p className="text-muted-foreground text-xs tabular-nums">{row.price ? formatMoney(row.price) : "No set price"}{row.sacCode ? ` · SAC ${row.sacCode}` : ""}</p>
            {errors[row.serviceId] ? <p role="alert" className="text-destructive-foreground text-xs">{errors[row.serviceId]}</p> : null}
          </div>
          <OptionSelect
            aria-label={`Tax for ${row.name}`}
            className="sm:w-64"
            value={encode(row)}
            options={optionsFor(row, defaultText)}
            disabled={!canEdit || busy === row.serviceId}
            onValueChange={(next) => void choose(row, next)}
          />
        </li>
      ))}
    </ul>
  );
}
