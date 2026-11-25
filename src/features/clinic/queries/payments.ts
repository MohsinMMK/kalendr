import { useQuery } from "@tanstack/react-query";

import type { MismatchView, PaymentSettingsView, ServicePayment } from "@/lib/payments";

import { staffKeys } from "./keys";
import { staffQuery } from "./http";

export const paymentKeys = {
  settings: () => [...staffKeys.all, "payments", "settings"] as const,
  mismatches: () => [...staffKeys.all, "payments", "mismatches"] as const,
  service: (serviceId: string) => [...staffKeys.all, "payments", "service", serviceId] as const,
};

/** GET /api/staff/payment-settings: the account, the policy and which providers are on offer. */
export function usePaymentSettings(enabled = true) {
  return useQuery({ queryKey: paymentKeys.settings(), queryFn: ({ signal }) => staffQuery<PaymentSettingsView>("/api/staff/payment-settings", signal), enabled });
}

/** GET /api/staff/payments/mismatches: open ones first. */
export function usePaymentMismatches(enabled = true) {
  return useQuery({ queryKey: paymentKeys.mismatches(), queryFn: ({ signal }) => staffQuery<MismatchView[]>("/api/staff/payments/mismatches", signal), enabled });
}

/** GET /api/staff/services/[id]/payment: the service's saved price and payment mode (answers with `ServicePayment`). */
export function useServicePayment(serviceId: string, enabled = true) {
  return useQuery({ queryKey: paymentKeys.service(serviceId), queryFn: ({ signal }) => staffQuery<ServicePayment>(`/api/staff/services/${serviceId}/payment`, signal), enabled });
}
