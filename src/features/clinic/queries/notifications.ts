import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { minuteSchema } from "@/lib/quiet-hours";
import { notificationListSchema, preferenceViewSchema, type NotificationList, type PreferenceView } from "@/lib/staff-alerts";
import { z } from "zod";

import { StaffApiError, staffMutation, staffQuery } from "./http";
import { staffKeys } from "./keys";

async function fetchNotifications(signal?: AbortSignal): Promise<NotificationList> {
  const parsed = notificationListSchema.safeParse(await staffQuery<unknown>("/api/staff/notifications", signal));
  if (!parsed.success) throw new StaffApiError("Your alerts could not be read.");
  return parsed.data;
}

/** The bell's list. A live "notification" event invalidates it, so it needs no timer of its own. */
export function useNotificationsQuery(enabled = true) {
  return useQuery({ queryKey: staffKeys.notifications(), queryFn: ({ signal }) => fetchNotifications(signal), enabled });
}

export function useMarkNotificationsRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { ids: string[] } | { all: true }) => {
      const parsed = notificationListSchema.safeParse(await staffMutation<unknown>("/api/staff/notifications/read", "POST", input));
      if (!parsed.success) throw new StaffApiError("Your alerts could not be read.");
      return parsed.data;
    },
    onSuccess: (list) => client.setQueryData(staffKeys.notifications(), list),
  });
}

export function useNotificationPreferences() {
  return useQuery({
    queryKey: staffKeys.notificationPreferences(),
    queryFn: async ({ signal }): Promise<PreferenceView[]> => {
      const parsed = z.array(preferenceViewSchema).safeParse(await staffQuery<unknown>("/api/staff/notifications/preferences", signal));
      if (!parsed.success) throw new StaffApiError("Your alert choices could not be read.");
      return parsed.data;
    },
  });
}

export function useSetNotificationPreference() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: PreferenceView) => {
      const parsed = z.array(preferenceViewSchema).safeParse(await staffMutation<unknown>("/api/staff/notifications/preferences", "PUT", input));
      if (!parsed.success) throw new StaffApiError("Your alert choices could not be read.");
      return parsed.data;
    },
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: staffKeys.notificationPreferences() });
      const previous = client.getQueryData<PreferenceView[]>(staffKeys.notificationPreferences());
      client.setQueryData<PreferenceView[]>(staffKeys.notificationPreferences(), (current) => current?.map((row) => (row.kind === input.kind ? input : row)));
      return { previous };
    },
    onError: (_error, _input, context) => client.setQueryData(staffKeys.notificationPreferences(), context?.previous),
    onSuccess: (rows) => client.setQueryData(staffKeys.notificationPreferences(), rows),
  });
}

const myNotificationsSchema = z.object({
  preferences: z.array(preferenceViewSchema),
  quietHours: z.object({ start: minuteSchema, end: minuteSchema }).nullable(),
  digest: z.object({ enabled: z.boolean(), minute: minuteSchema }),
  timezone: z.string(),
  digestOnByDefault: z.boolean(),
  summary: z.object({ frequency: z.enum(["off", "weekly", "monthly"]), available: z.boolean() }),
});
export type MyNotifications = z.infer<typeof myNotificationsSchema>;

/** Everything on the Notifications page: the events and channels, quiet hours and the morning digest (feature 56). */
export function useMyNotifications() {
  return useQuery({
    queryKey: staffKeys.myNotifications(),
    queryFn: async ({ signal }): Promise<MyNotifications> => {
      const parsed = myNotificationsSchema.safeParse(await staffQuery<unknown>("/api/staff/me/notifications", signal));
      if (!parsed.success) throw new StaffApiError("Your notification choices could not be read.");
      return parsed.data;
    },
  });
}

/** One switch in the grid. The page updates at once and goes back if the server refuses. */
export function useSetChannel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: PreferenceView) => {
      const parsed = z.array(preferenceViewSchema).safeParse(await staffMutation<unknown>("/api/staff/notifications/preferences", "PUT", input));
      if (!parsed.success) throw new StaffApiError("Your choices could not be read.");
      return parsed.data;
    },
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: staffKeys.myNotifications() });
      const previous = client.getQueryData<MyNotifications>(staffKeys.myNotifications());
      client.setQueryData<MyNotifications>(staffKeys.myNotifications(), (current) => current && { ...current, preferences: current.preferences.map((row) => (row.kind === input.kind ? input : row)) });
      return { previous };
    },
    onError: (_error, _input, context) => client.setQueryData(staffKeys.myNotifications(), context?.previous),
    onSuccess: (rows) => {
      client.setQueryData<MyNotifications>(staffKeys.myNotifications(), (current) => current && { ...current, preferences: rows });
      void client.invalidateQueries({ queryKey: staffKeys.notificationPreferences() });
    },
  });
}

export function useSaveQuietAndDigest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { quietHours: { start: number; end: number } | null; digest: { enabled: boolean; minute: number }; summaryFrequency?: "off" | "weekly" | "monthly" }) => {
      const parsed = myNotificationsSchema.safeParse(await staffMutation<unknown>("/api/staff/me/notifications", "PUT", input));
      if (!parsed.success) throw new StaffApiError("Your choices could not be read.");
      return parsed.data;
    },
    onSuccess: (saved) => client.setQueryData(staffKeys.myNotifications(), saved),
  });
}
