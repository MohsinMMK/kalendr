/**
 * The maths behind the picture editor: how a crop, a turn, a straighten, a flip and the three colour sliders turn a
 * chosen picture into one of exactly the size a kind of picture needs. Kept apart from the screen so it can be tested
 * without a browser.
 */

export interface Size {
  width: number;
  height: number;
}

/** A rectangle in the pixels of the picture being edited, measured on the picture after it was turned. */
export interface PixelArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PictureEdit {
  /** Whole turns to the right, 0 to 3. */
  quarterTurns: number;
  /** A small extra angle in degrees, to level a crooked horizon. */
  straighten: number;
  /** Mirrored left to right as it is seen, after any turn. */
  flipped: boolean;
  /** Each colour slider is a change from the original, 0 being "as taken". */
  brightness: number;
  contrast: number;
  saturation: number;
}

export const neutralEdit: PictureEdit = { quarterTurns: 0, straighten: 0, flipped: false, brightness: 0, contrast: 0, saturation: 0 };

/** Slider limits, in the same units as `PictureEdit`. */
export const editRanges = {
  straighten: { min: -30, max: 30, step: 0.5 },
  brightness: { min: -50, max: 50, step: 1 },
  contrast: { min: -50, max: 50, step: 1 },
  saturation: { min: -100, max: 100, step: 1 },
  zoom: { min: 1, max: 5, step: 0.01 },
} as const;

/** The largest edge of the working copy. A phone photo is shrunk to this before editing so the screen stays quick. */
export const workingEdge = 2_400;

export function isNeutral(edit: PictureEdit): boolean {
  return (
    edit.quarterTurns === 0 &&
    edit.straighten === 0 &&
    !edit.flipped &&
    edit.brightness === 0 &&
    edit.contrast === 0 &&
    edit.saturation === 0
  );
}

/** Whether the colour sliders change anything, so a plain crop skips the pixel pass. */
export function hasColorChange(edit: Pick<PictureEdit, "brightness" | "contrast" | "saturation">): boolean {
  return edit.brightness !== 0 || edit.contrast !== 0 || edit.saturation !== 0;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Turns by a quarter to the right (1) or left (-1), always landing on 0 to 3. */
export function turnQuarter(edit: PictureEdit, direction: 1 | -1): PictureEdit {
  return { ...edit, quarterTurns: (edit.quarterTurns + direction + 4) % 4 };
}

/** The whole angle the picture is turned by, in degrees. */
export function rotationDegrees(edit: Pick<PictureEdit, "quarterTurns" | "straighten">): number {
  return edit.quarterTurns * 90 + edit.straighten;
}

/** The smallest box that holds a picture of this size turned by this angle. */
export function rotatedBounds(size: Size, degrees: number): Size {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  return { width: size.width * cos + size.height * sin, height: size.width * sin + size.height * cos };
}

/** The largest rectangle of this shape (width over height) that fits inside a box. */
export function fitAspect(box: Size, aspect: number): Size {
  const width = Math.min(box.width, box.height * aspect);
  return { width, height: width / aspect };
}

/** How far the picture is moved from the centre, in screen pixels. */
export interface Point {
  x: number;
  y: number;
}

/**
 * How far in the picture must be zoomed so a frame of this size, in the same units as the picture as shown at zoom 1,
 * lies inside the turned picture when centred, with no empty corners. Turned by a multiple of 90 degrees nothing more
 * than the plain fit is needed; tilted, the picture's corners are cut off, so it has to grow.
 */
export function minimumZoomFor(media: Size, frame: Size, degrees: number): number {
  // The frame's footprint along the picture's own axes.
  const needed = rotatedBounds(frame, degrees);
  // Rounded up a hair so floating point never leaves a one-pixel sliver of empty corner.
  return Math.max(1, Math.ceil((Math.max(needed.width / media.width, needed.height / media.height) - 1e-9) * 1_000) / 1_000);
}

/**
 * The same, for a picture measured in its own pixels, where at zoom 1 the frame is the largest one of this shape
 * (width over height) that fits the box around the turned picture.
 */
export function minimumZoom(source: Size, aspect: number, degrees: number): number {
  return minimumZoomFor(source, fitAspect(rotatedBounds(source, degrees), aspect), degrees);
}

/**
 * Keeps the frame inside the turned picture while it is dragged: a tilted picture is not a box, so the plain box limit
 * would let its cut-off corners slide into the frame. `degrees` is the angle the picture is turned by on screen (the
 * opposite way when it is mirrored), `media` is the picture as shown at zoom 1 and `frame` the crop frame, both in
 * screen pixels. The position is the picture's centre measured from the frame's centre.
 */
export function clampPosition(position: Point, media: Size, frame: Size, zoom: number, degrees: number): Point {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const reach = rotatedBounds(frame, degrees);
  // Where the frame's centre sits, in the picture's own axes.
  const along = -position.x * cos - position.y * sin;
  const across = position.x * sin - position.y * cos;
  const limitAlong = Math.max(0, (media.width * zoom - reach.width) / 2);
  const limitAcross = Math.max(0, (media.height * zoom - reach.height) / 2);
  const u = clamp(along, -limitAlong, limitAlong);
  const v = clamp(across, -limitAcross, limitAcross);
  if (u === along && v === across) return position;
  return { x: -(u * cos - v * sin), y: -(u * sin + v * cos) };
}

/** The CSS `filter` the editor puts on its preview, in the same order and with the same meaning as `adjustPixels`. */
export function previewFilter(edit: Pick<PictureEdit, "brightness" | "contrast" | "saturation">): string {
  if (!hasColorChange(edit)) return "none";
  return `brightness(${1 + edit.brightness / 100}) contrast(${1 + edit.contrast / 100}) saturate(${1 + edit.saturation / 100})`;
}

type Matrix = readonly [number, number, number, number, number, number];

function multiply(left: Matrix, right: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = left;
  const [a2, b2, c2, d2, e2, f2] = right;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/**
 * The canvas transform that maps a point of the chosen picture onto the output picture: centre the picture, turn it,
 * mirror it, move the crop area to the corner, then scale that area up or down to the output size.
 */
export function pictureTransform(source: Size, area: PixelArea, edit: Pick<PictureEdit, "quarterTurns" | "straighten" | "flipped">, output: Size): Matrix {
  const degrees = rotationDegrees(edit);
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const box = rotatedBounds(source, degrees);
  const toCentre: Matrix = [1, 0, 0, 1, -source.width / 2, -source.height / 2];
  const rotate: Matrix = [cos, sin, -sin, cos, 0, 0];
  const mirror: Matrix = [edit.flipped ? -1 : 1, 0, 0, 1, 0, 0];
  const intoBox: Matrix = [1, 0, 0, 1, box.width / 2, box.height / 2];
  const toArea: Matrix = [1, 0, 0, 1, -area.x, -area.y];
  const scale: Matrix = [output.width / area.width, 0, 0, output.height / area.height, 0, 0];
  return [toCentre, rotate, mirror, intoBox, toArea, scale].reduceRight<Matrix>((total, step) => multiply(total, step), [1, 0, 0, 1, 0, 0]);
}

/**
 * Applies brightness, contrast and saturation to RGBA pixels in place, the way the CSS filters of the preview do:
 * brightness scales each channel, contrast pivots around mid grey, saturation blends toward the grey of each pixel.
 */
export function adjustPixels(data: Uint8ClampedArray, edit: Pick<PictureEdit, "brightness" | "contrast" | "saturation">): void {
  if (!hasColorChange(edit)) return;
  const brightness = 1 + edit.brightness / 100;
  const contrast = 1 + edit.contrast / 100;
  const saturation = 1 + edit.saturation / 100;
  // The saturate() matrix of the CSS filter specification.
  const a = 0.213 + 0.787 * saturation;
  const b = 0.715 - 0.715 * saturation;
  const c = 0.072 - 0.072 * saturation;
  const d = 0.213 - 0.213 * saturation;
  const e = 0.715 + 0.285 * saturation;
  const f = 0.072 - 0.072 * saturation;
  const g = 0.213 - 0.213 * saturation;
  const h = 0.715 - 0.715 * saturation;
  const i = 0.072 + 0.928 * saturation;
  // Each step is clamped to the 0 to 255 range before the next, as the filter chain does.
  const step = (value: number | undefined) => clamp(((clamp((value ?? 0) * brightness, 0, 255) / 255 - 0.5) * contrast + 0.5) * 255, 0, 255);
  for (let index = 0; index < data.length; index += 4) {
    const r = step(data[index]);
    const gr = step(data[index + 1]);
    const bl = step(data[index + 2]);
    data[index] = a * r + b * gr + c * bl;
    data[index + 1] = d * r + e * gr + f * bl;
    data[index + 2] = g * r + h * gr + i * bl;
  }
}
