import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";

import type {
  CustomerFieldDefinition, CustomerFieldValue, CustomerNote, CustomerSummary, CustomerTag, DuplicatePair, TimelineKind, TimelinePage,
} from "@/lib/customer-contracts";
import type { SegmentFilter, SegmentMember, SegmentSummary } from "@/lib/segment-filter";

import { staffKeys } from "./keys";
import { staffMutation, staffQuery } from "./http";

/** One key family per kind of customer data, so a change refetches only what it touched. */
export const customerKeys = {
  all: () => [...staffKeys.all, "customers"] as const,
  summary: (id: string) => [...staffKeys.all, "customers", id, "summary"] as const,
  timeline: (id: string, kinds: readonly TimelineKind[]) => [...staffKeys.all, "customers", id, "timeline", [...kinds].sort().join(",")] as const,
  notes: (id: string) => [...staffKeys.all, "customers", id, "notes"] as const,
  fieldValues: (id: string) => [...staffKeys.all, "customers", id, "fields"] as const,
  tags: () => [...staffKeys.all, "customer-tags"] as const,
  fields: () => [...staffKeys.all, "customer-fields"] as const,
  allFieldValues: () => [...staffKeys.all, "customers", "all-field-values"] as const,
  segments: () => [...staffKeys.all, "segments"] as const,
  members: (id: string) => [...staffKeys.all, "segments", id, "members"] as const,
  duplicates: () => [...staffKeys.all, "customer-duplicates"] as const,
};

export function useCustomerSummary(id: string | null, enabled = true) {
  return useQuery({ queryKey: customerKeys.summary(id ?? ""), queryFn: ({ signal }) => staffQuery<CustomerSummary>(`/api/staff/customers/${encodeURIComponent(id ?? "")}`, signal), enabled: enabled && Boolean(id) });
}

/** The timeline, a page at a time, newest first. The cursor the server hands back is passed on untouched. */
export function useTimeline(id: string, kinds: readonly TimelineKind[], enabled = true) {
  return useInfiniteQuery({
    queryKey: customerKeys.timeline(id, kinds),
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) => {
      const query = new URLSearchParams({ limit: "50" });
      if (kinds.length > 0) query.set("kinds", kinds.join(","));
      if (pageParam) query.set("cursor", pageParam);
      return staffQuery<TimelinePage>(`/api/staff/customers/${encodeURIComponent(id)}/timeline?${query}`, signal);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useCustomerNotes(id: string, enabled = true) {
  return useQuery({ queryKey: customerKeys.notes(id), queryFn: ({ signal }) => staffQuery<CustomerNote[]>(`/api/staff/customers/${encodeURIComponent(id)}/notes`, signal), enabled });
}

export function useCustomerTags(enabled = true) {
  return useQuery({ queryKey: customerKeys.tags(), queryFn: ({ signal }) => staffQuery<CustomerTag[]>("/api/staff/customer-tags", signal), enabled });
}

export function useFieldDefinitions(enabled = true) {
  return useQuery({ queryKey: customerKeys.fields(), queryFn: ({ signal }) => staffQuery<CustomerFieldDefinition[]>("/api/staff/customer-fields", signal), enabled });
}

/** Every visible customer's answers to the business's own fields, `{ customerId: { fieldId: value } }`, for the Customers table. */
export type FieldValueMap = Record<string, Record<string, string>>;

export function useFieldValueMap(enabled = true) {
  return useQuery({ queryKey: customerKeys.allFieldValues(), queryFn: ({ signal }) => staffQuery<FieldValueMap>("/api/staff/customer-fields/values", signal), enabled });
}

export function useFieldValues(id: string, enabled = true) {
  return useQuery({ queryKey: customerKeys.fieldValues(id), queryFn: ({ signal }) => staffQuery<CustomerFieldValue[]>(`/api/staff/customers/${encodeURIComponent(id)}/fields`, signal), enabled });
}

export function useSegments(enabled = true) {
  return useQuery({ queryKey: customerKeys.segments(), queryFn: ({ signal }) => staffQuery<SegmentSummary[]>("/api/staff/segments", signal), enabled });
}

export function useSegmentMembers(id: string | null) {
  return useInfiniteQuery({
    queryKey: customerKeys.members(id ?? ""),
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) => {
      const query = new URLSearchParams({ limit: "50" });
      if (pageParam) query.set("cursor", pageParam);
      return staffQuery<{ members: SegmentMember[]; nextCursor: string | null }>(`/api/staff/segments/${encodeURIComponent(id ?? "")}/members?${query}`, signal);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(id),
  });
}

/** How many customers a filter selects, refetched as the filter changes. The last answer stays on screen while the next loads. */
export function useSegmentCount(filter: SegmentFilter, enabled: boolean) {
  return useQuery({
    queryKey: [...customerKeys.segments(), "preview", JSON.stringify(filter)] as const,
    queryFn: () => staffMutation<{ count: number }>("/api/staff/segments/preview", "POST", { filter }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

export function useDuplicates(enabled = true) {
  return useQuery({ queryKey: customerKeys.duplicates(), queryFn: ({ signal }) => staffQuery<DuplicatePair[]>("/api/staff/customers/merge", signal), enabled });
}
