"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { Features } from "@/lib/business-types";
import { defaultBusinessProfile, profileWords, type BusinessProfile, type TermWords } from "@/lib/terminology";

interface BusinessProfileValue {
  profile: BusinessProfile;
  terms: TermWords;
}

const defaultValue: BusinessProfileValue = { profile: defaultBusinessProfile, terms: profileWords(defaultBusinessProfile) };

const BusinessProfileContext = createContext<BusinessProfileValue>(defaultValue);

/** Gives every screen below it one business's words and features. Without a provider, screens keep the healthcare words. */
export function BusinessProfileProvider({ profile, children }: { profile: BusinessProfile | null | undefined; children: ReactNode }) {
  const value = useMemo<BusinessProfileValue>(
    () => (profile ? { profile, terms: profileWords(profile) } : defaultValue),
    [profile],
  );
  return <BusinessProfileContext.Provider value={value}>{children}</BusinessProfileContext.Provider>;
}

export function useBusinessProfile(): BusinessProfile {
  return useContext(BusinessProfileContext).profile;
}

/** Words for copy: `t.Customers`, `t.aProvider`, `t.appointment`. */
export function useTerms(): TermWords {
  return useContext(BusinessProfileContext).terms;
}

export function useFeatures(): Features {
  return useContext(BusinessProfileContext).profile.features;
}
