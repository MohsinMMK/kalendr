import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { BookingLinkInput, BookingLinkView } from "@/lib/booking-links";
import type { TrackingUpdate } from "@/lib/embed/tracking";
import type { EmailTimesView, EmbedContextView } from "@/server/email-times";
import type { TrackingView } from "@/server/embed-tracking";

import { staffMutation, staffQuery } from "../queries/http";

const keys = {
  context: ["staff", "embed", "context"] as const,
  links: ["staff", "embed", "links"] as const,
  tracking: ["staff", "embed", "tracking"] as const,
  times: (serviceId: string) => ["staff", "embed", "times", serviceId] as const,
};

export function useEmbedContext(enabled: boolean) {
  return useQuery({ queryKey: keys.context, queryFn: ({ signal }) => staffQuery<EmbedContextView>("/api/staff/embed/context", signal), enabled });
}

export function useShortLinks(enabled: boolean) {
  return useQuery({ queryKey: keys.links, queryFn: ({ signal }) => staffQuery<BookingLinkView[]>("/api/staff/short-links", signal), enabled });
}

export function useCreateShortLink() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: BookingLinkInput) => staffMutation<BookingLinkView>("/api/staff/short-links", "POST", input),
    onSuccess: (created) => client.setQueryData<BookingLinkView[]>(keys.links, (current) => [created, ...(current ?? [])]),
  });
}

export function useDeleteShortLink() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => staffMutation<{ deleted: true }>(`/api/staff/short-links/${encodeURIComponent(id)}`, "DELETE", {}),
    onSuccess: (_result, id) => client.setQueryData<BookingLinkView[]>(keys.links, (current) => current?.filter((link) => link.id !== id)),
  });
}

export function useTracking(enabled: boolean) {
  return useQuery({ queryKey: keys.tracking, queryFn: ({ signal }) => staffQuery<TrackingView>("/api/staff/tracking", signal), enabled });
}

export function useSaveTracking() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TrackingUpdate) => staffMutation<TrackingView>("/api/staff/tracking", "PUT", input),
    onSuccess: (saved) => client.setQueryData(keys.tracking, saved),
  });
}

export function useEmailTimes(serviceId: string | null) {
  return useQuery({
    queryKey: keys.times(serviceId ?? "none"),
    queryFn: ({ signal }) => staffQuery<EmailTimesView>(`/api/staff/embed/email-times?serviceId=${encodeURIComponent(serviceId ?? "")}`, signal),
    enabled: Boolean(serviceId),
    staleTime: 60_000,
  });
}
