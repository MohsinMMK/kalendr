"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";

import { parseTheme, resolveTheme, themeCookie, type ThemeChoice } from "./theme-choice";

export { parseTheme, themeCookie, type ThemeChoice };

interface ThemeState {
  choice: ThemeChoice;
  resolved: "light" | "dark";
  setChoice: (choice: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

const darkQuery = "(prefers-color-scheme: dark)";
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Light, dark or follow the device. The choice is kept in a cookie so the server can draw the first paint in
 * the right colours; the page's root element carries the class too, so menus and dialogs outside the frame match.
 */
export function StaffThemeProvider({ initial, children }: { initial: ThemeChoice; children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(initial);
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(darkQuery);
    const update = () => setSystemDark(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const resolved = resolveTheme(choice, systemDark);
  useIsomorphicLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolved);
    root.style.colorScheme = resolved;
    // Public pages never inherit this: the class goes when the staff frame goes.
    return () => { root.classList.remove("dark"); root.classList.add("light"); root.style.colorScheme = ""; };
  }, [resolved]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    document.cookie = `${themeCookie}=${next}; path=/; max-age=31536000; samesite=lax`;
  }, []);

  const value = useMemo(() => ({ choice, resolved, setChoice }), [choice, resolved, setChoice]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useStaffTheme(): ThemeState {
  const context = useContext(ThemeContext);
  if (!context) return { choice: "light", resolved: "light", setChoice: () => undefined };
  return context;
}
