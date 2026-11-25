import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { StaffApiError, staffMutation, staffQuery } from "@/features/clinic/queries/http";
import { staffKeys } from "@/features/clinic/queries/keys";
import {
  billingStateSchema,
  checkoutResultSchema,
  planLimitDetailsSchema,
  planLimitErrorCode,
  type BillingState,
  type CheckoutResult,
  type PlanLimitDetails,
} from "@/lib/billing-contracts";
import { planDefinitions, planKeys, type PlanKey } from "@/lib/entitlements";

export const billingKey = [...staffKeys.all, "billing"] as const;

const unreadable = "Your plan and billing could not be read.";

export function parseBillingState(value: unknown): BillingState {
  const parsed = billingStateSchema.safeParse(value);
  if (!parsed.success) throw new StaffApiError(unreadable);
  return parsed.data;
}

export const fetchBillingState = async (signal?: AbortSignal) => parseBillingState(await staffQuery<unknown>("/api/staff/billing", signal));

/** The plan and billing state. `enabled` is false in the preview and for roles that never see it. */
export function useBillingState(enabled = true) {
  return useQuery({ queryKey: billingKey, queryFn: ({ signal }) => fetchBillingState(signal), enabled, staleTime: 30_000 });
}

function refresh(client: QueryClient) {
  return client.invalidateQueries({ queryKey: billingKey });
}

export function useStartCheckout() {
  return useMutation({
    mutationFn: async (planKey: Exclude<PlanKey, "free">): Promise<CheckoutResult> => {
      const parsed = checkoutResultSchema.safeParse(await staffMutation<unknown>("/api/staff/billing/checkout", "POST", { planKey }));
      if (!parsed.success) throw new StaffApiError("Checkout could not be started. Try again.");
      return parsed.data;
    },
  });
}

/** Change, cancel and resume answer with no body we rely on: refetch the state afterwards. */
export function useChangePlan() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (planKey: PlanKey) => staffMutation<unknown>("/api/staff/billing/change-plan", "POST", { planKey }),
    onSuccess: () => refresh(client),
  });
}

export function useCancelPlan() {
  const client = useQueryClient();
  return useMutation({ mutationFn: () => staffMutation<unknown>("/api/staff/billing/cancel", "POST", {}), onSuccess: () => refresh(client) });
}

export function useResumePlan() {
  const client = useQueryClient();
  return useMutation({ mutationFn: () => staffMutation<unknown>("/api/staff/billing/resume", "POST", {}), onSuccess: () => refresh(client) });
}

export function useSaveBillingSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { overageMode?: BillingState["overageMode"]; billingGstin?: string | null }) =>
      staffMutation<unknown>("/api/staff/billing/settings", "PATCH", input),
    onSuccess: () => refresh(client),
  });
}

/** Refetches until `done` is true or the tries run out (the webhook may land a few seconds after payment). Resolves whether it did. */
export async function waitForState(client: QueryClient, done: (state: BillingState) => boolean, options: { tries?: number; delayMs?: number } = {}): Promise<boolean> {
  const { tries = 6, delayMs = 2000 } = options;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const state = parseBillingState(await staffQuery<unknown>("/api/staff/billing"));
      client.setQueryData(billingKey, state);
      if (done(state)) return true;
    } catch {
      // Keep trying: a dropped request should not end the wait.
    }
    if (attempt < tries - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

/** What the server said about a refused plan limit, or a safe stand-in when it sent nothing readable. */
export function planLimitFromError(error: unknown): PlanLimitDetails | null {
  if (!(error instanceof StaffApiError) || error.code !== planLimitErrorCode) return null;
  const parsed = planLimitDetailsSchema.safeParse(error.details);
  if (parsed.success) return parsed.data;
  return { subject: "plan", requiredPlan: null, currentPlan: "free", limit: null };
}

/** Preview mode has no billing tables: a labelled sample, with checkout off. */
export function previewBillingState(currency: "INR" | "USD" = "INR"): BillingState {
  const now = Date.now();
  return {
    plan: { key: "growth", name: "Growth", status: "trialing", reason: "trial", trialEndsAt: new Date(now + 9 * 86_400_000).toISOString(), graceEndsAt: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, pendingPlanKey: null },
    provider: null,
    checkoutProvider: currency === "INR" ? "razorpay" : "stripe",
    currency,
    plans: planKeys.map((key) => ({ key, name: planDefinitions[key].name, priceMinor: currency === "INR" ? planDefinitions[key].priceInrMinor : planDefinitions[key].priceUsdMinor, currency, limits: planDefinitions[key].limits })),
    usage: [
      { metric: "whatsapp", used: 120, included: 1000 },
      { metric: "sms", used: 40, included: 500 },
      { metric: "bookings", used: 31, included: null },
    ],
    overageMode: "stop_marketing",
    billingGstin: null,
    invoices: [],
    banner: null,
    checkoutAvailable: false,
  };
}
