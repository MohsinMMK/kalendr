"use client";

import { useEffect, useRef } from "react";

import { emitEmbedEvent } from "@/lib/embed/events";
import { requestHostRedirect } from "@/lib/embed/bridge";
import { readEmbedBridge } from "@/lib/embed/query";
import type { Service, TimeSlot } from "@/lib/domain";

import type { BookingSuccess } from "./booking-types";

/**
 * Raises the embed events for a booking in progress (feature 52): a service chosen, a time chosen and the booking made. The
 * bridge passes them to the website around the page and the conversion pixels hear them too. Failures are raised where the
 * booking is submitted. After a booking it also sends the customer to the business's own thank-you page when the service is set to.
 */
export function useEmbedEvents({ service, slot, success }: { service: Service | undefined; slot: TimeSlot | undefined; success: BookingSuccess | undefined }): void {
  const serviceId = service?.id;
  useEffect(() => {
    if (serviceId) emitEmbedEvent("service_selected", { serviceId });
  }, [serviceId]);

  const slotId = slot?.id;
  const slotRef = useRef(slot);
  useEffect(() => {
    slotRef.current = slot;
  });
  useEffect(() => {
    const chosen = slotRef.current;
    if (slotId && chosen) emitEmbedEvent("slot_selected", { serviceId, practitionerId: chosen.practitionerId, startsAt: chosen.startsAt, endsAt: chosen.endsAt });
  }, [slotId, serviceId]);

  const appointmentId = success?.appointmentId;
  const successRef = useRef(success);
  const raisedFor = useRef<string | undefined>(undefined);
  const redirectsRef = useRef(service?.afterBooking?.mode === "redirect");
  useEffect(() => {
    successRef.current = success;
    redirectsRef.current = service?.afterBooking?.mode === "redirect";
  });
  useEffect(() => {
    const made = successRef.current;
    if (!appointmentId || !made) return;
    if (raisedFor.current !== appointmentId) {
      raisedFor.current = appointmentId;
      emitEmbedEvent("booked", { serviceId, appointmentId, startsAt: made.startsAt, endsAt: made.endsAt, status: made.status });
    }
    if (made.previewMode || !redirectsRef.current) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/public/booking-redirect", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manageToken: made.manageToken }), signal: controller.signal,
        });
        const payload = (await response.json()) as { data?: { url?: string | null } };
        const url = payload.data?.url;
        if (!response.ok || typeof url !== "string") return;
        const bridge = readEmbedBridge(Object.fromEntries(new URLSearchParams(window.location.search)));
        // Inside the website's frame the website follows the address (its loader checks it); anywhere else this page does.
        if (bridge) requestHostRedirect(bridge, url);
        else window.location.assign(url);
      } catch {
        // The customer stays on Kalendr's confirmation if the address could not be fetched.
      }
    })();
    return () => controller.abort();
  }, [appointmentId, serviceId]);
}
