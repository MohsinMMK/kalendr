"use client";

import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";

/**
 * The server cannot see the screen, so it guesses the device from the request (see `viewportGuess`) and the
 * first HTML is laid out for that guess. A phone then gets its own layout straight away, instead of the desktop
 * one swapped out once the scripts arrive. The same guess is used while the page hydrates, so both agree; after
 * that the real screen decides.
 */
export type ViewportGuess = "phone" | "desktop";

/** The width each guess stands for. */
const guessedWidth: Record<ViewportGuess, number> = { phone: 390, desktop: 1280 };
/** The Tailwind breakpoints the staff screens switch layout at. */
const breakpoints = { sm: 640, xl: 1280 } as const;

const ViewportGuessContext = createContext<ViewportGuess | null>(null);

export function ViewportGuessProvider({ guess, children }: { guess: ViewportGuess | null; children: ReactNode }) {
  return <ViewportGuessContext value={guess}>{children}</ViewportGuessContext>;
}

/** True when the screen is narrower than the breakpoint, like `useMediaQuery("max-sm")`, but rendered for the guessed device on the server. */
export function useNarrowerThan(breakpoint: keyof typeof breakpoints): boolean {
  const guess = useContext(ViewportGuessContext);
  const width = breakpoints[breakpoint];
  const query = `(max-width: ${width - 1}px)`;
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => guess !== null && guessedWidth[guess] < width,
  );
}
