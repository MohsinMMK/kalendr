"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import type { ServiceBookingOptions } from "@/lib/service-booking-options";

import { StaffApiError } from "./queries/http";
import { useSaveServiceBookingOptions, useServiceBookingOptions } from "./queries/service-booking-options";

/**
 * One self-saving switch on a service, shared by the two lane B fields. Turning it on or off saves at once, so the
 * service editor only has to place the field; it needs no part in the editor's own Save.
 */
export function ServiceBookingOptionSwitch({ serviceId, option, label, hint, saves = true }: {
  serviceId: string;
  option: keyof ServiceBookingOptions;
  label: string;
  hint: string;
  /** False in the preview, where nothing is stored. */
  saves?: boolean;
}) {
  const query = useServiceBookingOptions(serviceId, saves);
  const save = useSaveServiceBookingOptions(serviceId);
  if (!saves) return <Alert variant="info"><AlertDescription>This setting is not saved in the preview.</AlertDescription></Alert>;
  if (query.isPending) return <Skeleton role="status" aria-label={`Loading ${label}`} className="h-11 w-full" />;
  if (query.isError) {
    return <Alert variant="error"><AlertDescription>{query.error instanceof StaffApiError ? query.error.message : "This setting could not be loaded."}</AlertDescription></Alert>;
  }
  return (
    <Field className="w-full">
      <Label className="min-h-11 items-center justify-between gap-4 font-normal">
        <span className="flex flex-col gap-0.5">
          <span className="font-medium text-sm">{label}</span>
          <span className="text-muted-foreground text-xs">{hint}</span>
        </span>
        <Switch
          aria-label={label}
          checked={query.data[option]}
          disabled={save.isPending}
          onCheckedChange={(next) => save.mutate({ [option]: next }, {
            onError: (error) => toastManager.add({ type: "error", title: "Not saved", description: error instanceof Error ? error.message : "The change could not be saved." }),
          })}
        />
      </Label>
    </Field>
  );
}
