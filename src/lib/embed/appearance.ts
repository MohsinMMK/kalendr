import { z } from "zod";

/** How the website asked the booking page to look: `?theme=light|dark|auto` and `?brand=1f6feb` (hex, no hash). */
export const embedThemes = ["light", "dark", "auto"] as const;
export type EmbedTheme = (typeof embedThemes)[number];

const hexSchema = z.string().regex(/^[0-9a-fA-F]{6}$/);

export interface EmbedAppearance {
  theme: EmbedTheme;
  /** `#rrggbb`, or null to keep the business's own colour. */
  brand: string | null;
}

export function readEmbedAppearance(params: URLSearchParams): EmbedAppearance {
  const theme = params.get("theme");
  const brand = hexSchema.safeParse(params.get("brand") ?? "");
  return {
    theme: embedThemes.find((candidate) => candidate === theme) ?? "auto",
    brand: brand.success ? `#${brand.data.toLowerCase()}` : null,
  };
}

/** Black or white text, whichever is easier to read on this colour (WCAG relative luminance). */
export function readableOn(hex: string): "#ffffff" | "#111111" {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.4 ? "#111111" : "#ffffff";
}
