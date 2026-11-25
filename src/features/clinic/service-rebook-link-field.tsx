"use client";

import { useTerms } from "@/features/terms/business-profile-context";

import { ServiceBookingOptionSwitch } from "./service-booking-option-switch";

/**
 * Whether an old reschedule link offers "Book again". To place it, render
 * `<ServiceRebookLinkField serviceId={…} saves={…} />` in the cancelling or timing section of the service editor.
 */
export function ServiceRebookLinkField({ serviceId, saves = true }: { serviceId: string; saves?: boolean }) {
  const t = useTerms();
  return (
    <ServiceBookingOptionSwitch
      serviceId={serviceId}
      saves={saves}
      option="rebookFromOldLink"
      label="Offer “Book again” on an old reschedule link"
      hint={`A ${t.customer} who opens a link from before their ${t.appointment} moved sees the new time, and can book again from here. The old link can never change anything.`}
    />
  );
}
