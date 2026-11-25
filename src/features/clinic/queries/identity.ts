import { useQuery } from "@tanstack/react-query";

import type { StaffBrand } from "@/server/brand";
import type { CreatedDomain, DomainOverview, StaffEmbedOrigin } from "@/server/domains/service";

import { staffKeys } from "./keys";
import { staffQuery } from "./http";

export const identityKeys = {
  brand: () => [...staffKeys.all, "brand"] as const,
  domains: () => [...staffKeys.all, "domains"] as const,
  embedOrigins: () => [...staffKeys.all, "embed-origins"] as const,
};

export type { CreatedDomain, DomainOverview, StaffBrand, StaffEmbedOrigin };

/** GET /api/staff/brand */
export function useBrand(enabled = true) {
  return useQuery({ queryKey: identityKeys.brand(), queryFn: ({ signal }) => staffQuery<StaffBrand>("/api/staff/brand", signal), enabled });
}

/**
 * GET /api/staff/domains. While an address is waiting for a check (`pending`) the list is read again every few
 * seconds, so the answer from the worker shows up without anyone pressing a button.
 */
export function useDomains(enabled = true) {
  return useQuery({
    queryKey: identityKeys.domains(),
    queryFn: ({ signal }) => staffQuery<DomainOverview>("/api/staff/domains", signal),
    enabled,
    refetchInterval: (query) => (query.state.data?.domains.some((domain) => domain.state === "pending") ? 4_000 : false),
  });
}

/** GET /api/staff/embed-origins */
export function useEmbedOrigins(enabled = true) {
  return useQuery({
    queryKey: identityKeys.embedOrigins(),
    queryFn: async ({ signal }) => (await staffQuery<{ origins: StaffEmbedOrigin[] }>("/api/staff/embed-origins", signal)).origins,
    enabled,
  });
}
