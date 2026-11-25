"use client";

import { CalendarClock, ExternalLink, Globe, PlayCircle, SlidersHorizontal } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { useBusinessProfile, useTerms } from "@/features/terms/business-profile-context";
import { isClinicalBusinessType } from "@/lib/business-types";

import { useCatalogLookups } from "./clinic-catalog";
import { useNavLabels } from "./sidebar-nav";
import { requestProductTour } from "./product-tour";
import { useStaffAccess } from "./staff-access";

export function HelpDialog({
  open,
  onClose,
  clinicSlug,
}: {
  open: boolean;
  onClose: () => void;
  clinicSlug: string;
}) {
  const t = useTerms();
  const labels = useNavLabels();
  const profile = useBusinessProfile();
  const clinical = isClinicalBusinessType(profile.businessType);
  const database = useCatalogLookups().database;
  const canManage = useStaffAccess().can("settings.manage");
  const canTour = database && canManage;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPopup
        bottomStickOnMobile={false}
        closeProps={{ "aria-label": "Close help" }}
        className="max-h-[min(36rem,100%)] max-w-md"
      >
        <DialogHeader>
          <DialogTitle>{labels.help}</DialogTitle>
          <DialogDescription>Keep the public booking page current so {t.customers} choose a time the {t.business} can keep.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <dl className="flex flex-col gap-4 text-sm">
            <div className="flex gap-3">
              <SlidersHorizontal aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="flex flex-col gap-0.5">
                <dt className="font-medium">{t.Customer} page</dt>
                <dd className="text-muted-foreground">Open {labels.settings} to change the {t.business} name, phone, address, and the {clinical ? "visit types" : t.services} {t.customers} can book.</dd>
              </div>
            </div>
            <div className="flex gap-3">
              <CalendarClock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="flex flex-col gap-0.5">
                <dt className="font-medium">Hours and leave</dt>
                <dd className="text-muted-foreground">Set each {t.practitioner}’s working days, lunch, and closed time so those openings disappear from public booking.</dd>
              </div>
            </div>
            <div className="flex gap-3">
              <Globe aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="font-medium">Public booking</dt>
                <dd className="text-muted-foreground">{t.Customers} book at <code className="break-all">/book/{clinicSlug}</code>. Kalendr handles scheduling.{clinical ? " It is not an emergency service." : null}</dd>
              </div>
            </div>
          </dl>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Close</DialogClose>
          {canTour ? <Button variant="outline" onClick={() => { onClose(); requestProductTour(); }}><PlayCircle aria-hidden="true" />Take the tour</Button> : null}
          <Button variant="outline" render={<Link href={`/book/${clinicSlug}`} />}>Open booking page <ExternalLink aria-hidden="true" /></Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
