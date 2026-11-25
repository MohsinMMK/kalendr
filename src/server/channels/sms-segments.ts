/**
 * How many SMS segments a text costs. A text made only of GSM-7 characters holds 160
 * characters in one segment, or 153 per part when it needs several. Any other character
 * (Hindi, an emoji, a curly quote) switches the whole text to UCS-2: 70 code units in one
 * segment, 67 per part. Providers bill by segment, so the usage meter needs this number.
 *
 * Pure and dependency free: the worker and the web app both use it.
 */

const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
/** Sent as an escape plus the character, so each one takes two units. */
const GSM_EXTENSION = new Set("\f^{}\\[~]|€");

export type SmsEncoding = "gsm7" | "ucs2";

export interface SmsSegmentCount {
  encoding: SmsEncoding;
  /** Characters (GSM-7) or UTF-16 code units (UCS-2) the text takes. */
  units: number;
  segments: number;
}

/** The slot a DLT template leaves for a variable. */
export const DLT_VARIABLE_SLOT = "{#var#}";

/** The approved wording with each slot replaced, in order. A missing value leaves the slot empty. */
export function fillApprovedText(approvedText: string, variables: readonly string[]): string {
  let index = 0;
  return approvedText.split(DLT_VARIABLE_SLOT).reduce((text, part, position) => {
    if (position === 0) return part;
    const value = variables[index] ?? "";
    index += 1;
    return `${text}${value}${part}`;
  }, "");
}

function gsmWidths(text: string): number[] | null {
  const widths: number[] = [];
  for (const character of text) {
    if (GSM_BASIC.has(character)) widths.push(1);
    else if (GSM_EXTENSION.has(character)) widths.push(2);
    else return null;
  }
  return widths;
}

/** Splits widths into parts of `capacity`; a character is never split across two parts. */
function partsNeeded(widths: readonly number[], capacity: number): number {
  let parts = 1;
  let used = 0;
  for (const width of widths) {
    if (used + width > capacity) {
      parts += 1;
      used = 0;
    }
    used += width;
  }
  return parts;
}

export function countSmsSegments(text: string): SmsSegmentCount {
  if (text.length === 0) return { encoding: "gsm7", units: 0, segments: 0 };
  const gsm = gsmWidths(text);
  const encoding: SmsEncoding = gsm ? "gsm7" : "ucs2";
  // A UTF-16 pair (an emoji) is two units and must stay in one part.
  const widths = gsm ?? Array.from(text, (character) => character.length);
  const units = widths.reduce((sum, width) => sum + width, 0);
  const single = encoding === "gsm7" ? 160 : 70;
  const multi = encoding === "gsm7" ? 153 : 67;
  const segments = units <= single ? 1 : partsNeeded(widths, multi);
  return { encoding, units, segments };
}

/**
 * The segments a template will cost once filled in, or null when the template has no approved
 * wording to count (the channel then reports its own number). The lead wires this into
 * notifications.segments; see the hand-off note in the feature report.
 */
export function smsSegmentsFor(approvedText: string | null | undefined, variables: readonly string[]): number | null {
  return approvedText ? countSmsSegments(fillApprovedText(approvedText, variables)).segments : null;
}
