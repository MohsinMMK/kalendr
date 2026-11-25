import { z } from "zod";

import { embedThemes } from "./appearance";

/**
 * What the embed builder in the share sheet chooses, and the snippet it writes (feature 52). The snippet is one script tag
 * with data attributes: the same options the `Kalendr.embed()` call takes, so a developer can switch to code later.
 */
export const embedModes = ["inline", "popup", "floating"] as const;
export type EmbedMode = (typeof embedModes)[number];

export const embedModeLabels: Record<EmbedMode, { label: string; description: string }> = {
  inline: { label: "On the page", description: "Booking sits inside your page, like a section." },
  popup: { label: "Popup button", description: "A button opens booking in a window over your page." },
  floating: { label: "Floating button", description: "A button stays in the corner of every page." },
};

export const embedOptionsSchema = z.object({
  mode: z.enum(embedModes),
  /** Link-safe name of one service, or null for the business's whole booking page. */
  service: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).nullable(),
  theme: z.enum(embedThemes),
  /** `#rrggbb`, or null to keep the business's own colour. */
  brand: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  label: z.string().trim().max(40),
  position: z.enum(["left", "right"]),
});
export type EmbedOptions = z.infer<typeof embedOptionsSchema>;

export const defaultEmbedOptions: EmbedOptions = { mode: "inline", service: null, theme: "auto", brand: null, label: "Book an appointment", position: "right" };

/** Escapes text for an HTML attribute value. */
export function attribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const EMBED_MOUNT_ID = "kalendr-booking";

/** The one snippet to paste: a mount element where one is needed, then the script. */
export function embedSnippet(origin: string, business: string, options: EmbedOptions): string {
  const base = origin.replace(/\/$/, "");
  const lines = [
    `<script`,
    `  src="${attribute(base)}/embed.js"`,
    `  data-kalendr-business="${attribute(business)}"`,
  ];
  if (options.service) lines.push(`  data-kalendr-service="${attribute(options.service)}"`);
  lines.push(`  data-kalendr-mode="${options.mode}"`);
  if (options.mode !== "floating") lines.push(`  data-kalendr-mount="#${EMBED_MOUNT_ID}"`);
  if (options.theme !== "auto") lines.push(`  data-kalendr-theme="${options.theme}"`);
  if (options.brand) lines.push(`  data-kalendr-brand="${options.brand.slice(1).toLowerCase()}"`);
  if (options.mode !== "inline" && options.label) lines.push(`  data-kalendr-label="${attribute(options.label)}"`);
  if (options.mode === "floating" && options.position === "left") lines.push(`  data-kalendr-position="left"`);
  lines.push(`  defer`, `></script>`);
  const mount = options.mode === "floating" ? "" : `<div id="${EMBED_MOUNT_ID}"></div>\n`;
  return `${mount}${lines.join("\n")}`;
}

/** The snippet a developer adds to listen for booking steps. Ids and times only. */
export const eventListenerSnippet = `<script>
  // Works wherever it sits on the page, before or after the embed script.
  window.addEventListener("kalendr:booked", function (event) {
    // event.detail.appointmentId, .serviceId, .startsAt, .endsAt
  });
</script>`;

/** The booking page address a link or QR code opens. */
export function bookingPageUrl(origin: string, business: string, service: string | null): string {
  return `${origin.replace(/\/$/, "")}/book/${business}${service ? `/${service}` : ""}`;
}
