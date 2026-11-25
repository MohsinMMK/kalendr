import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ListingUpdate, ListingView } from "@/lib/listing";

import { staffMutation, staffQuery } from "./http";
import { staffKeys } from "./keys";

const key = () => [...staffKeys.all, "listing"] as const;

/** GET /api/staff/settings/listing */
export function useListing(enabled = true) {
  return useQuery({ queryKey: key(), queryFn: ({ signal }) => staffQuery<ListingView>("/api/staff/settings/listing", signal), enabled });
}

/** PATCH /api/staff/settings/listing */
export function useSaveListing() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ListingUpdate) => staffMutation<ListingView>("/api/staff/settings/listing", "PATCH", input),
    onSuccess: (saved) => client.setQueryData(key(), saved),
  });
}
