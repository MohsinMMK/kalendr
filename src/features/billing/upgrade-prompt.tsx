"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import type { BillingPlanView, PlanLimitDetails } from "@/lib/billing-contracts";

import { planLimitFromError, useBillingState } from "./billing-api";
import { requestBillingSection } from "./billing-navigation";
import { UpgradeDialog } from "./upgrade-dialog";

export interface UpgradePrompt {
  /** Opens the dialog for a refusal. */
  open: (details: PlanLimitDetails) => void;
  /** Opens the dialog when the error is a `plan_limit` refusal and says so. Use in a catch: `if (upgrade.fromError(cause)) return;` */
  fromError: (error: unknown) => boolean;
  /** The plans, when this person may see them (owners). */
  plans: readonly BillingPlanView[];
}

const noPlans: readonly BillingPlanView[] = [];
const fallback: UpgradePrompt = { open: () => {}, fromError: () => false, plans: noPlans };
const UpgradePromptContext = createContext<UpgradePrompt | null>(null);

/** Safe to call anywhere: with no provider mounted (a test, the preview) nothing opens and `fromError` answers false. */
export function useUpgradePrompt(): UpgradePrompt {
  return useContext(UpgradePromptContext) ?? fallback;
}

/** Mounted once in the staff frame. `billingEnabled` is true for the owner on a real database: only then are the plans fetched. */
export function UpgradePromptProvider({ children, billingEnabled, isOwner }: { children: ReactNode; billingEnabled: boolean; isOwner: boolean }) {
  const [details, setDetails] = useState<PlanLimitDetails | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const state = useBillingState(billingEnabled && details !== null);
  const plans = state.data?.plans ?? noPlans;
  const open = useCallback((next: PlanLimitDetails) => setDetails(next), []);
  const fromError = useCallback((error: unknown) => {
    const found = planLimitFromError(error);
    if (found) setDetails(found);
    return found !== null;
  }, []);
  const value = useMemo<UpgradePrompt>(() => ({ open, fromError, plans }), [open, fromError, plans]);
  return (
    <UpgradePromptContext.Provider value={value}>
      {children}
      <UpgradeDialog
        details={details}
        plans={plans}
        isOwner={isOwner}
        onClose={() => setDetails(null)}
        onSeePlans={() => {
          setDetails(null);
          requestBillingSection();
          // A sheet or task page can be open on top: leave it for the Settings page, which opens at the section asked for.
          if (!pathname.startsWith("/settings")) router.push("/settings");
        }}
      />
    </UpgradePromptContext.Provider>
  );
}
