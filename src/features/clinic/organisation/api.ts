"use client";

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import type {
  AttributeView, CustomRoleView, DomainView, OrgDefaults, PersonAttributesView, ScimTokenView, TeamView,
} from "@/lib/enterprise-contracts";
import { staffMutation, staffQuery } from "../queries/http";
import { useStepUp } from "../step-up-dialog";

/** Under ["staff"] so signing out clears them with everything else. */
const base = ["staff", "organisation"] as const;
export const orgKeys = {
  teams: [...base, "teams"] as const,
  roles: [...base, "roles"] as const,
  attributes: [...base, "attributes"] as const,
  defaults: [...base, "defaults"] as const,
  domains: [...base, "domains"] as const,
  tokens: [...base, "scim-tokens"] as const,
  reassign: [...base, "reassign"] as const,
  all: base,
};

export interface ReassignmentNeeded { timeOffId: string; practitionerId: string; name: string; bookings: number }

export const useTeams = (): UseQueryResult<TeamView[]> => useQuery({ queryKey: orgKeys.teams, queryFn: ({ signal }) => staffQuery<TeamView[]>("/api/staff/teams", signal) });
export const useRoles = (enabled = true): UseQueryResult<CustomRoleView[]> => useQuery({ queryKey: orgKeys.roles, enabled, queryFn: ({ signal }) => staffQuery<CustomRoleView[]>("/api/staff/roles", signal) });
export const useAttributes = (): UseQueryResult<{ attributes: AttributeView[]; people: PersonAttributesView[] }> => useQuery({ queryKey: orgKeys.attributes, queryFn: ({ signal }) => staffQuery("/api/staff/attributes", signal) });
export const useOrgDefaults = (): UseQueryResult<OrgDefaults> => useQuery({ queryKey: orgKeys.defaults, queryFn: ({ signal }) => staffQuery<OrgDefaults>("/api/staff/org-defaults", signal) });
export const useDomains = (): UseQueryResult<DomainView[]> => useQuery({ queryKey: orgKeys.domains, queryFn: ({ signal }) => staffQuery<DomainView[]>("/api/staff/org/domains", signal) });
export const useScimTokens = (): UseQueryResult<ScimTokenView[]> => useQuery({ queryKey: orgKeys.tokens, queryFn: ({ signal }) => staffQuery<ScimTokenView[]>("/api/staff/org/scim/tokens", signal) });
export const useReassignments = (): UseQueryResult<ReassignmentNeeded[]> => useQuery({ queryKey: orgKeys.reassign, queryFn: ({ signal }) => staffQuery<ReassignmentNeeded[]>("/api/staff/org/reassign", signal) });

interface Change { path: string; method: "POST" | "PATCH" | "PUT" | "DELETE"; body?: unknown }

/**
 * One change to the organisation. `stepUp` wraps it so a stale second-factor check asks for a code and retries once; every save
 * refreshes the organisation lists, and the team list in the snapshot too, because roles show up there.
 */
export function useOrgChange<T = unknown>(options: { stepUp?: boolean } = {}) {
  const client = useQueryClient();
  const { runWithStepUp } = useStepUp();
  return useMutation({
    mutationFn: (change: Change) => {
      const send = () => staffMutation<T>(change.path, change.method, change.body ?? {});
      return options.stepUp ? runWithStepUp(send) : send();
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: orgKeys.all });
      await client.invalidateQueries({ queryKey: ["staff", "snapshot"] });
    },
  });
}
