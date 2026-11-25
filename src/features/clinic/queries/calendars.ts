import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  calendarOverviewSchema,
  feedCreatedSchema,
  type AppleConnectInput,
  type CalendarOverview,
  type ConflictAction,
  type EventTextSetting,
  type SelectionPatch,
} from "@/lib/calendar-sync";
import { z } from "zod";

import { StaffApiError, staffMutation, staffQuery } from "./http";
import { staffKeys } from "./keys";

const unreadable = "Your calendars could not be read.";

function parseOverview(value: unknown): CalendarOverview {
  const parsed = calendarOverviewSchema.safeParse(value);
  if (!parsed.success) throw new StaffApiError(unreadable);
  return parsed.data;
}

/** True while one of this person's own connections is still waiting for the worker to check it. */
export function hasPendingConnection(overview: CalendarOverview | undefined): boolean {
  return Boolean(overview?.connections.some((connection) => connection.mine && connection.status === "pending"));
}

/** The overview. Polls every 3 seconds while one of my connections is pending, and not otherwise. */
export function useCalendarOverview(enabled = true) {
  return useQuery({
    queryKey: staffKeys.calendars(),
    queryFn: async ({ signal }) => parseOverview(await staffQuery<unknown>("/api/staff/calendars", signal)),
    enabled,
    refetchInterval: (query) => (hasPendingConnection(query.state.data) ? 3000 : false),
  });
}

/** Where the browser goes to connect Google or Outlook. A plain navigation: the provider asks for consent and sends the person back. */
export function connectPath(provider: "google" | "microsoft"): string {
  return `/api/staff/calendars/connect/${provider}`;
}

/** A change that answers with the new overview. A version conflict reloads the overview so the screen shows the truth. */
function useOverviewMutation<Input>(send: (input: Input) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: Input) => parseOverview(await send(input)),
    onSuccess: (overview) => client.setQueryData(staffKeys.calendars(), overview),
    onError: (error) => {
      if (error instanceof StaffApiError && error.code === "version_conflict") void client.invalidateQueries({ queryKey: staffKeys.calendars() });
    },
  });
}

export function isVersionConflict(error: unknown): boolean {
  return error instanceof StaffApiError && error.code === "version_conflict";
}

export function useConnectApple() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: AppleConnectInput) => {
      const parsed = z.object({ connectionId: z.string() }).safeParse(await staffMutation<unknown>("/api/staff/calendars/connect/apple", "POST", input));
      if (!parsed.success) throw new StaffApiError(unreadable);
      return parsed.data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: staffKeys.calendars() }),
  });
}

export function useChangeSelection() {
  return useOverviewMutation(({ id, patch }: { id: string; patch: SelectionPatch }) =>
    staffMutation<unknown>(`/api/staff/calendars/selections/${id}`, "PATCH", patch));
}

export function useDisconnectCalendar() {
  return useOverviewMutation((id: string) => staffMutation<unknown>(`/api/staff/calendars/connections/${id}`, "DELETE", {}));
}

export function useSaveEventText() {
  return useOverviewMutation((eventText: EventTextSetting) => staffMutation<unknown>("/api/staff/calendars/settings", "PUT", { eventText }));
}

export function useResolveConflict() {
  return useOverviewMutation(({ id, action }: { id: string; action: ConflictAction["action"] }) =>
    staffMutation<unknown>(`/api/staff/calendars/conflicts/${id}`, "POST", { action }));
}

/** Makes (or replaces) the private feed address. The address is in the answer once; the cache only learns the feed is on. */
export function useCreateFeed() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const parsed = feedCreatedSchema.safeParse(await staffMutation<unknown>("/api/staff/calendars/feed", "POST", {}));
      if (!parsed.success) throw new StaffApiError("The link could not be made.");
      return parsed.data;
    },
    onSuccess: (created) =>
      client.setQueryData<CalendarOverview>(staffKeys.calendars(), (current) =>
        current ? { ...current, feed: { active: true, createdAt: created.createdAt } } : current),
  });
}

export function useRevokeFeed() {
  return useOverviewMutation(() => staffMutation<unknown>("/api/staff/calendars/feed", "DELETE", {}));
}
