import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { StepAction } from "@/server/onboarding/progress";
import type { OnboardingState } from "@/server/onboarding/progress";
import type { SampleDataResult, TestBookingView } from "@/server/onboarding/test-data";

import { staffKeys } from "./keys";
import { staffMutation, staffQuery } from "./http";

export type { OnboardingState, SampleDataResult, TestBookingView };

export const onboardingKeys = { state: () => [...staffKeys.all, "onboarding"] as const };

/** GET /api/staff/onboarding. `null` data means the preview, which has no checklist. */
export function useOnboarding(enabled = true) {
  return useQuery({
    queryKey: onboardingKeys.state(),
    queryFn: ({ signal }) => staffQuery<OnboardingState | null>("/api/staff/onboarding", signal),
    enabled,
    staleTime: 15_000,
  });
}

/** Writes a change and puts the new state straight into the cache. */
function useOnboardingMutation<Input, Output>(run: (input: Input) => Promise<Output>, apply?: (output: Output) => OnboardingState | null | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: async (output) => {
      const next = apply?.(output);
      if (next !== undefined) client.setQueryData(onboardingKeys.state(), next);
      else await client.invalidateQueries({ queryKey: onboardingKeys.state() });
    },
  });
}

export function useStepAction() {
  return useOnboardingMutation((input: StepAction) => staffMutation<OnboardingState | null>("/api/staff/onboarding", "POST", input), (state) => state);
}

export function useTourAction() {
  return useOnboardingMutation((action: "done" | "skip" | "reopen") => staffMutation<{ action: string }>("/api/staff/onboarding/tour", "POST", { action }));
}

export function useAddSampleData() {
  return useOnboardingMutation(() => staffMutation<SampleDataResult>("/api/staff/onboarding/sample-data", "POST", {}));
}

export function useRemoveTestData() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => staffMutation<{ appointmentsRemoved: number; customersRemoved: number; appointmentsRetired: number; customersKept: number }>("/api/staff/onboarding/test-data", "DELETE", {}),
    onSuccess: async () => {
      // The schedule and customers change too.
      await client.invalidateQueries({ queryKey: staffKeys.all });
    },
  });
}

/** POST /api/staff/onboarding/test-booking: looks for the owner's booking made since the panel opened. */
export function findTestBooking(since: string): Promise<TestBookingView> {
  return staffMutation<TestBookingView>("/api/staff/onboarding/test-booking", "POST", { since });
}
