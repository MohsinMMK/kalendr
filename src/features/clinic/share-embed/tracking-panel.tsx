"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";

import { TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { trackingSettingsSchema, type TrackingSettings } from "@/lib/embed/tracking";

import { StaffApiError } from "../queries/http";
import { useSaveTracking, useTracking } from "./queries";

const blank = (value: string): string | null => (value.trim() === "" ? null : value.trim());

/**
 * The business's own tracking ids. Ids only, never script code. Each provider's official snippet is added to the booking page
 * (never to staff or customer account pages), and only after the visitor allows analytics cookies.
 */
export function TrackingPanel() {
  const tracking = useTracking(true);
  const save = useSaveTracking();
  const form = useForm<z.input<typeof trackingSettingsSchema>, unknown, TrackingSettings>({ resolver: zodResolver(trackingSettingsSchema), defaultValues: { googleAnalyticsId: null, tagManagerId: null, metaPixelId: null, plausibleDomain: null } });
  const { errors, isDirty } = form.formState;

  useEffect(() => {
    if (tracking.data) form.reset({ googleAnalyticsId: tracking.data.googleAnalyticsId, tagManagerId: tracking.data.tagManagerId, metaPixelId: tracking.data.metaPixelId, plausibleDomain: tracking.data.plausibleDomain });
  }, [tracking.data, form]);

  if (tracking.isPending) return <div className="flex flex-col gap-3" role="status" aria-label="Loading tracking"><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" /></div>;
  if (tracking.isError) {
    return <Alert variant="error"><AlertDescription><p>{tracking.error.message}</p><Button size="sm" variant="outline" className="mt-2" onClick={() => void tracking.refetch()}>Try again</Button></AlertDescription></Alert>;
  }

  async function submit(values: TrackingSettings): Promise<void> {
    try {
      await save.mutateAsync({ ...values, expectedVersion: tracking.data?.version ?? 0 });
      toastManager.add({ title: "Tracking saved", type: "success" });
    } catch (error: unknown) {
      if (error instanceof StaffApiError && Object.keys(error.fieldErrors).length > 0) {
        for (const [path, messages] of Object.entries(error.fieldErrors)) form.setError(path as never, { type: "server", message: messages[0] ?? "Check this." });
      } else toastManager.add({ title: error instanceof Error ? error.message : "Tracking could not be saved.", type: "error" });
    }
  }

  const field = (name: keyof TrackingSettings) => form.register(name, { setValueAs: blank });
  return (
    <form noValidate onSubmit={(event) => { void form.handleSubmit(submit)(event); }} className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">Enter your ids. Kalendr adds the official snippet on your booking pages only, after the visitor allows analytics cookies. Nothing loads for visitors who say no, and Kalendr sends the providers no names, emails or phone numbers. Providers read the page address as usual, so keep personal details out of the links you share.</p>
      <TextField label="Google Analytics" optional placeholder="G-ABC123XYZ" autoCapitalize="characters" spellCheck={false} error={errors.googleAnalyticsId?.message} {...field("googleAnalyticsId")} />
      <TextField label="Google Tag Manager" optional placeholder="GTM-ABC123" autoCapitalize="characters" spellCheck={false} error={errors.tagManagerId?.message} {...field("tagManagerId")} />
      <TextField label="Meta (Facebook) pixel" optional placeholder="123456789012345" inputMode="numeric" spellCheck={false} error={errors.metaPixelId?.message} {...field("metaPixelId")} />
      <TextField label="Plausible domain" optional placeholder="example.com" autoCapitalize="none" spellCheck={false} error={errors.plausibleDomain?.message} {...field("plausibleDomain")} />
      <Button type="submit" size="lg" className="self-start" disabled={!isDirty || save.isPending}>
        {save.isPending ? <Spinner aria-hidden="true" /> : null}
        Save tracking
      </Button>
    </form>
  );
}
