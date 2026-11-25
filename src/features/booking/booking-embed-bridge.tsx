"use client";

import { useEffect } from "react";

import { startEmbedBridge } from "@/lib/embed/bridge";
import { readEmbedAppearance, readableOn } from "@/lib/embed/appearance";

/**
 * Connects an embedded booking page to the website around it (feature 52) and applies the theme and brand colour the
 * website asked for. The connection logic lives in `src/lib/embed/bridge.ts`.
 */
export function BookingEmbedBridge({ nonce, parentOrigin }: { nonce: string; parentOrigin: string }) {
  useEffect(() => startEmbedBridge({ nonce, parentOrigin }), [nonce, parentOrigin]);
  return <EmbedAppearance />;
}

/** The theme and brand colour the website chose, from the page address. Skipped outside a frame. */
export function EmbedAppearance() {
  useEffect(() => {
    const appearance = readEmbedAppearance(new URLSearchParams(window.location.search));
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => root.classList.toggle("dark", appearance.theme === "dark" || (appearance.theme === "auto" && media.matches));
    if (appearance.theme !== "auto") apply();
    else if (media.matches) apply();
    if (appearance.theme === "auto") media.addEventListener("change", apply);
    if (appearance.brand) {
      root.style.setProperty("--primary", appearance.brand);
      root.style.setProperty("--primary-foreground", readableOn(appearance.brand));
    }
    return () => {
      media.removeEventListener("change", apply);
      root.style.removeProperty("--primary");
      root.style.removeProperty("--primary-foreground");
    };
  }, []);
  return null;
}
