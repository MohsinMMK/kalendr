import { z } from "zod";

/**
 * A business's look on public pages and emails (feature 13). Pure rules, no database: the stored `tenants.brand`
 * json is cleaned by `parseBrand` on every read, and `brandStyle` turns it into CSS variables. The accent is the
 * only free colour an owner picks, so this file also decides whether text on it is readable and which text colour
 * to use when it is not. Logo and cover are pictures in `media_assets`, not part of this json.
 */

export const cornerStyles = ["square", "soft", "round"] as const;
export type CornerStyle = (typeof cornerStyles)[number];

/** One plain #rrggbb colour. The stored value can reach inline CSS and emails, so nothing else is ever accepted. */
export const accentSchema = z.string().trim().toLowerCase().regex(/^#[0-9a-f]{6}$/, "Use a colour like #0f766e.");

export const brandSettingsSchema = z.object({
  accent: accentSchema.nullable(),
  corners: z.enum(cornerStyles),
  hideBadge: z.boolean(),
});
export type BrandSettings = z.infer<typeof brandSettingsSchema>;

export const defaultBrand: BrandSettings = { accent: null, corners: "soft", hideBadge: false };

/** Checks each stored field on its own, so one bad value never throws away the others. */
export function parseBrand(value: unknown): BrandSettings {
  const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const accent = accentSchema.safeParse(source.accent);
  const corners = z.enum(cornerStyles).safeParse(source.corners);
  return {
    accent: accent.success ? accent.data : null,
    corners: corners.success ? corners.data : defaultBrand.corners,
    hideBadge: source.hideBadge === true,
  };
}

const radiusFor: Record<CornerStyle, string> = { square: "0.25rem", soft: "0.625rem", round: "1rem" };

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)) as [number, number, number];
}

/** WCAG 2.x relative luminance of a #rrggbb colour. */
export function relativeLuminance(hex: string): number {
  const [red, green, blue] = channels(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG contrast ratio between two colours, from 1 to 21. */
export function contrastRatio(first: string, second: string): number {
  const [light, dark] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

export const lightText = "#ffffff";
export const darkText = "#000000";

export interface AccentReading {
  /** The colour for text and icons placed on the accent (buttons, badges). */
  text: string;
  /** Contrast of that text on the accent. At least 4.5 for AA body text, which every accent reaches with one of the two (white or black; the worst case is a mid-tone at about 4.58). */
  ratio: number;
  /** True when white would not have been readable and dark text was chosen instead. */
  usesDarkText: boolean;
  /** Plain sentences for the owner about what was done. Empty when the accent needs no help. */
  notes: string[];
}

/**
 * Picks white or dark text for an accent. A yellow accent gets dark text on its own, and the owner is told so.
 * Also warns when the accent is so pale that it would vanish as a ring or a line on a white page.
 */
export function readAccent(accent: string): AccentReading {
  const withLight = contrastRatio(accent, lightText);
  const withDark = contrastRatio(accent, darkText);
  const usesDarkText = withLight < 4.5 && withDark > withLight;
  const text = usesDarkText ? darkText : lightText;
  const notes: string[] = [];
  if (usesDarkText) notes.push("This colour is light, so buttons use dark text to stay easy to read.");
  if (contrastRatio(accent, "#ffffff") < 1.6) notes.push("This colour is very pale. Buttons will show, but thin lines in this colour may be hard to see on a white page.");
  return { text, ratio: Math.round(Math.max(withLight, withDark) * 100) / 100, usesDarkText, notes };
}

/**
 * The CSS variables that give a public page the business's look: the coss `--primary` pair, the focus ring, and the
 * corner radius. Set as an inline style on the page wrapper, so staff screens keep Kalendr's own colours.
 */
export function brandStyle(brand: BrandSettings): Record<string, string> {
  const style: Record<string, string> = { "--radius": radiusFor[brand.corners] };
  if (brand.accent) {
    const { text } = readAccent(brand.accent);
    style["--primary"] = brand.accent;
    style["--primary-foreground"] = text;
    style["--ring"] = `color-mix(in srgb, ${brand.accent} 65%, transparent)`;
    style["--sidebar-primary"] = brand.accent;
    style["--sidebar-primary-foreground"] = text;
  }
  return style;
}

/** What emails use: the accent and the text colour for buttons. Falls back to the product teal. */
export function emailAccent(brand: BrandSettings, fallback: string): { accent: string; text: string } {
  const accent = brand.accent ?? fallback;
  return { accent, text: readAccent(accent).text };
}
