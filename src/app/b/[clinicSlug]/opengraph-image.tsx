import { ImageResponse } from "next/og";

import { readAccent } from "@/lib/brand-theme";
import { mediaIdFromUrl } from "@/lib/media";
import { readPublicMedia } from "@/server/media";

import { getBusinessCatalog } from "./catalog";

/** The preview picture shown when a business's link is pasted into WhatsApp, Instagram or a search result: name, place, colour and logo. */
export const alt = "Book an appointment online";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
// A new logo or colour shows in link previews within the hour.
export const revalidate = 3600;

const fallbackAccent = "#0f766e";

/** The logo as a data address, read straight from the file store (no request to anywhere). Only formats the renderer draws. */
async function logoDataUri(slug: string, logoUrl: string | null | undefined): Promise<string | null> {
  const mediaId = logoUrl ? mediaIdFromUrl(logoUrl) : null;
  if (!mediaId) return null;
  try {
    const media = await readPublicMedia(slug, mediaId);
    if (!media || (media.contentType !== "image/png" && media.contentType !== "image/jpeg") || media.bytes.byteLength > 1_500_000) return null;
    return `data:${media.contentType};base64,${Buffer.from(media.bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

export default async function Image({ params }: { params: Promise<{ clinicSlug: string }> }) {
  const { clinicSlug } = await params;
  const catalog = await getBusinessCatalog(clinicSlug).catch(() => null);
  // A link that names no business (or a paused one) has no picture; nothing is drawn or kept for it.
  if (!catalog) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  const name = catalog.clinic.name;
  const city = catalog.locations.find((location) => location.isActive !== false)?.city ?? null;
  const accent = catalog.clinic.brand?.accent ?? fallbackAccent;
  const text = readAccent(accent).text;
  const logo = await logoDataUri(clinicSlug, catalog.clinic.logoUrl);
  const initial = name.trim().charAt(0).toUpperCase() || "K";
  // Long names shrink so they stay on the picture.
  const fontSize = name.length > 40 ? 56 : name.length > 24 ? 72 : 92;

  return new ImageResponse(
    (
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: "100%", height: "100%", background: accent, color: text, padding: 72 }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          {logo ? (
            <img src={logo} width={120} height={120} alt="" style={{ borderRadius: 24, background: "#ffffff", objectFit: "contain" }} />
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 120, height: 120, borderRadius: 24, background: text, color: accent, fontSize: 72, fontWeight: 700 }}>{initial}</div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize, fontWeight: 700, lineHeight: 1.1, display: "flex" }}>{name}</div>
          {city ? <div style={{ fontSize: 40, marginTop: 20, opacity: 0.9, display: "flex" }}>{city}</div> : null}
        </div>
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ display: "flex", fontSize: 36, fontWeight: 600, padding: "16px 36px", borderRadius: 999, background: text, color: accent }}>Book online</div>
        </div>
      </div>
    ),
    size,
  );
}
