/** Shared rules for business pictures (logo, cover, one photo per service) and a person's own photo. */

export const mediaKinds = ["business_logo", "business_cover", "service", "staff_photo"] as const;
export type MediaKind = (typeof mediaKinds)[number];

/** Hard limit on stored picture size. Pictures are resized in the browser first. */
export const maxMediaBytes = 600 * 1_024;

/** Target size for each kind of picture, after the browser crops and resizes it. */
export const mediaTargets: Record<MediaKind, { width: number; height: number }> = {
  business_logo: { width: 256, height: 256 },
  business_cover: { width: 1600, height: 900 },
  service: { width: 960, height: 720 },
  staff_photo: { width: 256, height: 256 },
};

/** The shape of the crop frame in the picture editor: a person is round, a logo a rounded square, the rest plain rectangles. */
export const mediaShapes: Record<MediaKind, "round" | "rounded" | "rect"> = {
  business_logo: "rounded",
  business_cover: "rect",
  service: "rect",
  staff_photo: "round",
};

/** What the picture editor calls each kind of picture. */
export const mediaSubjects: Record<MediaKind, string> = {
  business_logo: "Logo",
  business_cover: "Cover photo",
  service: "Service picture",
  staff_photo: "Photo",
};

/** A team member's booking-profile photo is stored in their own row as a small data address, not as a media picture. */
export const personPhoto = { width: 256, height: 256, quality: 0.85 } as const;

export function isMediaKind(value: unknown): value is MediaKind {
  return typeof value === "string" && (mediaKinds as readonly string[]).includes(value);
}

/** The permanent public address of a picture. */
export function mediaUrl(businessSlug: string, mediaId: string): string {
  return `/api/public/media/${encodeURIComponent(businessSlug)}/${encodeURIComponent(mediaId)}`;
}

/** The picture id at the end of a stored picture's address, for removing it. Other addresses, such as the preview's sample drawings, have none. */
export function mediaIdFromUrl(url: string): string | null {
  const path = url.split("?")[0] ?? "";
  if (!path.startsWith("/api/public/media/")) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 5) return null;
  const last = parts.at(-1);
  return last ? decodeURIComponent(last) : null;
}
