import { adjustPixels, hasColorChange, pictureTransform, workingEdge, type PictureEdit, type PixelArea, type Size } from "@/lib/picture-edit";

const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const maxSourceBytes = 10 * 1_024 * 1_024;

export function photoProblem(file: Pick<File, "type" | "size">): string | null {
  if (!allowedTypes.has(file.type)) return "Choose a JPEG, PNG or WebP photo.";
  if (file.size > maxSourceBytes) return "Choose a photo smaller than 10 MB.";
  return null;
}

/** A picture read and ready to edit: a working copy on a canvas, and an address the editor can show it from. */
export interface PictureSource {
  canvas: HTMLCanvasElement;
  size: Size;
  previewUrl: string;
}

const unreadable = "This browser could not read the picture.";

async function decode(source: File | string): Promise<{ image: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof source !== "string") {
    const bitmap = await createImageBitmap(source);
    return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  }
  // A saved picture (an address on this site, or one held in the page) is read through an image, which the page's
  // security policy allows for these addresses, and which applies the picture's own orientation.
  const image = new Image();
  image.src = source;
  await image.decode();
  return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => undefined };
}

/**
 * Reads a chosen file, or a saved picture by its address, into a working copy no bigger than `workingEdge` on its
 * longest side. A transparent picture is put on white, as it is when saved. Re-encoding also strips location and other
 * EXIF data.
 */
export async function loadPictureSource(source: File | string): Promise<PictureSource> {
  if (typeof source !== "string") {
    const problem = photoProblem(source);
    if (problem) throw new Error(problem);
  }
  const decoded = await decode(source).catch(() => {
    throw new Error(unreadable);
  });
  try {
    if (!decoded.width || !decoded.height) throw new Error(unreadable);
    const scale = Math.min(1, workingEdge / Math.max(decoded.width, decoded.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(decoded.width * scale));
    canvas.height = Math.max(1, Math.round(decoded.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error(unreadable);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = "high";
    context.drawImage(decoded.image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) throw new Error(unreadable);
    return { canvas, size: { width: canvas.width, height: canvas.height }, previewUrl: URL.createObjectURL(blob) };
  } finally {
    decoded.close();
  }
}

export function releasePictureSource(source: PictureSource | null): void {
  if (source) URL.revokeObjectURL(source.previewUrl);
}

/**
 * Cuts the chosen area out of the picture, with the turn, straighten, flip and colour changes applied, and encodes it
 * as a JPEG of exactly `output` pixels. Smaller pictures are scaled up so every picture of a kind has one size.
 */
export async function renderPicture(
  source: PictureSource,
  area: PixelArea,
  edit: PictureEdit,
  output: Size,
  quality = 0.82,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = output.width;
  canvas.height = output.height;
  const context = canvas.getContext("2d", { willReadFrequently: hasColorChange(edit) });
  if (!context) throw new Error(unreadable);
  // Empty corners, where a straightened picture does not reach the frame, are white.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, output.width, output.height);
  context.imageSmoothingQuality = "high";
  const [a, b, c, d, e, f] = pictureTransform(source.size, area, edit, output);
  context.setTransform(a, b, c, d, e, f);
  context.drawImage(source.canvas, 0, 0);
  context.setTransform(1, 0, 0, 1, 0, 0);
  if (hasColorChange(edit)) {
    const pixels = context.getImageData(0, 0, output.width, output.height);
    adjustPixels(pixels.data, edit);
    context.putImageData(pixels, 0, 0);
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error(unreadable);
  return blob;
}

/** A picture as the data address the team's booking-profile photos are stored as. */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(unreadable)));
    reader.onerror = () => reject(new Error(unreadable));
    reader.readAsDataURL(blob);
  });
}
