"use client";

import { useTerms } from "@/features/terms/business-profile-context";

import { ServiceBookingOptionSwitch } from "./service-booking-option-switch";

/**
 * "Fewer gaps": also offer the start right after (and right before) a booking. To place it, render
 * `<ServiceOptimizedSlotsField serviceId={…} saves={…} />` in the timing section of the service editor.
 */
export function ServiceOptimizedSlotsField({ serviceId, saves = true }: { serviceId: string; saves?: boolean }) {
  const t = useTerms();
  return (
    <ServiceBookingOptionSwitch
      serviceId={serviceId}
      saves={saves}
      option="optimizedSlots"
      label="Offer times next to existing bookings"
      hint={`Times that start right when another ${t.appointment} ends are offered too, so the day has fewer gaps. The usual times still show.`}
    />
  );
}
