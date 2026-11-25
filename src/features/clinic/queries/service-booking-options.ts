import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ServiceBookingOptions, ServiceBookingOptionsInput } from "@/lib/service-booking-options";

import { staffMutation, staffQuery } from "./http";

export const bookingOptionsKey = (serviceId: string) => ["staff", "service-booking-options", serviceId] as const;

/** GET /api/staff/services/[id]/booking-options */
export function useServiceBookingOptions(serviceId: string, enabled = true) {
  return useQuery({ queryKey: bookingOptionsKey(serviceId), queryFn: ({ signal }) => staffQuery<ServiceBookingOptions>(`/api/staff/services/${serviceId}/booking-options`, signal), enabled });
}

/** PUT: saves one or both switches at once, and keeps the other field's copy fresh. */
export function useSaveServiceBookingOptions(serviceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ServiceBookingOptionsInput) => staffMutation<ServiceBookingOptions>(`/api/staff/services/${serviceId}/booking-options`, "PUT", input),
    onSuccess: (saved) => client.setQueryData(bookingOptionsKey(serviceId), saved),
  });
}
