"use client";

import { HydrationBoundary, MutationCache, QueryCache, QueryClient, QueryClientProvider, type DehydratedState } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

import { StaffApiError } from "./http";

/**
 * Staff data is fresh for a short time and refetched when the window gets focus again, so a diary left open
 * in a tab catches up when the receptionist comes back to it. Live events (feature 32) will invalidate the
 * keys in `keys.ts` for instant refresh.
 */
/** One quiet retry for a dropped connection. A refusal (signed out, not allowed, bad request) will not change by asking again. */
function retryOnce(count: number, error: Error): boolean {
  if (error instanceof StaffApiError && error.status >= 400 && error.status < 500) return false;
  return count < 1;
}

export function createStaffQueryClient(onError?: (error: Error) => void): QueryClient {
  return new QueryClient({
    queryCache: onError ? new QueryCache({ onError }) : undefined,
    mutationCache: onError ? new MutationCache({ onError }) : undefined,
    defaultOptions: {
      queries: { staleTime: 15_000, gcTime: 5 * 60_000, refetchOnWindowFocus: true, retry: retryOnce },
      mutations: { retry: false },
    },
  });
}

let leaving = false;
/**
 * The session ended while the page was open (signed out on another device, or it expired). Asking again
 * will not help, so go to sign-in, once.
 */
function signInAgainWhenSignedOut(error: Error) {
  if (leaving || !(error instanceof StaffApiError) || error.status !== 401) return;
  leaving = true;
  // A full page load on purpose: nothing from the ended session stays in memory. This runs outside React, where there is no router.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign("/sign-in");
}

// The client lives outside React, so what was loaded survives the frame remounting (sign-in, Setup, printing).
let browserClient: QueryClient | null = null;
let browserScope: string | null = null;

/**
 * The browser's one client. When a different person (or business) is signed in than last time, everything
 * cached for the previous one is dropped first, so staff data never outlives the session it was fetched for.
 */
export function browserStaffQueryClient(scope: string): QueryClient {
  // The server renders for many people at once, so it never shares a client between requests.
  if (typeof window === "undefined") return createStaffQueryClient();
  browserClient ??= createStaffQueryClient(signInAgainWhenSignedOut);
  if (browserScope !== null && browserScope !== scope) browserClient.clear();
  browserScope = scope;
  return browserClient;
}

/** Drops every cached staff record. Called on sign-out. */
export function clearStaffQueryCache() {
  browserClient?.clear();
  browserScope = null;
}

/** `prefetched` is data the server loaded with the page; it fills the cache only where the cache holds nothing newer. */
export function StaffQueryProvider({ children, scope, client, prefetched }: { children: ReactNode; scope: string; client?: QueryClient; prefetched?: DehydratedState }) {
  const [resolved] = useState(() => client ?? browserStaffQueryClient(scope));
  return (
    <QueryClientProvider client={resolved}>
      {prefetched ? <HydrationBoundary state={prefetched}>{children}</HydrationBoundary> : children}
    </QueryClientProvider>
  );
}
