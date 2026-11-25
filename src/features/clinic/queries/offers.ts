import { useQuery } from "@tanstack/react-query";

import type { CustomerOffers, OffersSummary } from "@/lib/offers-contracts";

import { staffKeys } from "./keys";
import { staffQuery } from "./http";

export const offerKeys = {
  all: () => [...staffKeys.all, "offers"] as const,
  summary: () => [...staffKeys.all, "offers", "summary"] as const,
  customer: (patientId: string) => [...staffKeys.all, "offers", "customer", patientId] as const,
};

/** GET /api/staff/offers: every package, plan and code of this business. */
export function useOffers(enabled = true) {
  return useQuery({ queryKey: offerKeys.summary(), queryFn: ({ signal }) => staffQuery<OffersSummary>("/api/staff/offers", signal), enabled });
}

/** GET /api/staff/packages/customer: one customer's packages (with history) and memberships. */
export function useCustomerOffers(patientId: string | null, enabled = true) {
  return useQuery({
    queryKey: offerKeys.customer(patientId ?? ""),
    queryFn: ({ signal }) => staffQuery<CustomerOffers>(`/api/staff/packages/customer?patientId=${encodeURIComponent(patientId ?? "")}`, signal),
    enabled: enabled && Boolean(patientId),
  });
}
