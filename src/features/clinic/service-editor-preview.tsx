"use client";

import { Eye } from "lucide-react";
import { useWatch, type Control } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Drawer, DrawerDescription, DrawerHeader, DrawerPanel, DrawerPopup, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { RadioGroup } from "@/components/ui/radio-group";
import { getDurationLabel } from "@/features/booking/booking-format";
import { lengthPrice, serviceLengths } from "@/features/booking/booking-options";
import { ServiceCard } from "@/features/booking/service-card";
import { useTerms } from "@/features/terms/business-profile-context";
import type { Service } from "@/lib/domain";

import type { ServiceFormValues } from "./service-editor-model";
import { previewServiceFrom } from "./service-preview-model";

/**
 * What a customer sees for this service, from the values on screen (saved or not). It uses the real booking card, so
 * a change to the name, length or price shows here as you type. Nothing in it can be pressed.
 */
export function ServicePreview({ control, base }: { control: Control<ServiceFormValues>; base: Service }) {
  const t = useTerms();
  const values = useWatch({ control });
  const service = previewServiceFrom(values as Partial<ServiceFormValues>, base);
  const lengths = serviceLengths(service);
  return (
    <div className="flex flex-col gap-3" data-testid="service-preview">
      <p className="font-medium text-muted-foreground text-xs" id="service-preview-title">How {t.customers} see it</p>
      <div inert aria-labelledby="service-preview-title" className="flex flex-col gap-3">
        <RadioGroup value={service.id} aria-label={`Preview of ${service.name}`}>
          <ServiceCard service={service} layout={service.imageUrl ? "picture" : "text"} />
        </RadioGroup>
        {lengths.length > 1 ? (
          <div className="flex flex-col gap-2 rounded-xl border bg-card p-3">
            <p className="font-medium text-sm">How long would you like?</p>
            <ul className="flex flex-col gap-1.5">
              {lengths.map((length) => (
                <li key={length.minutes} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
                  <span>{getDurationLabel(length.minutes)}{length.isDefault ? <span className="ms-2 text-muted-foreground text-xs">usual</span> : null}</span>
                  <span className="text-muted-foreground tabular-nums">{lengthPrice(length, service, false) ?? ""}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      {service.visibility === "hidden" ? <p className="text-muted-foreground text-xs">Hidden from the booking page list. It still books from its own link.</p> : null}
      {service.isActive === false ? <p className="text-muted-foreground text-xs">Switched off, so {t.customers} cannot book it.</p> : null}
    </div>
  );
}

/** Below 1024px the preview opens from a button instead of sitting beside the form. */
export function ServicePreviewDrawer({ control, base }: { control: Control<ServiceFormValues>; base: Service }) {
  const t = useTerms();
  return (
    <Drawer position="bottom">
      <DrawerTrigger render={<Button type="button" variant="outline" size="sm" className="min-h-11 lg:hidden" />}><Eye aria-hidden="true" /> Preview</DrawerTrigger>
      <DrawerPopup showBar>
        <DrawerHeader>
          <DrawerTitle>Preview</DrawerTitle>
          <DrawerDescription>What {t.customers} see. It follows what you type, before you save.</DrawerDescription>
        </DrawerHeader>
        <DrawerPanel><ServicePreview control={control} base={base} /></DrawerPanel>
      </DrawerPopup>
    </Drawer>
  );
}
