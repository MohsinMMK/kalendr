/**
 * A tiny PDF writer for the readable copy of a customer's data: plain text on A4 pages, in the built-in Helvetica font.
 * It exists so the export needs no new library. Letters outside the Western European set the PDF font covers (for
 * example Devanagari) print as "?" here; the JSON file in the same download is the complete copy, and the export says so.
 *
 * No "server-only" import: the worker uses this file.
 */

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const FONT_SIZE = 10.5;
const LEADING = 14;
const MAX_CHARS = 92;

export interface PdfLine {
  text: string;
  /** Larger bold-looking heading. */
  heading?: boolean;
}

/** Characters the standard PDF font can draw: printable Latin-1. */
function printable(text: string): string {
  let out = "";
  for (const character of text.normalize("NFC")) {
    const code = character.codePointAt(0) ?? 63;
    out += (code >= 32 && code <= 126) || (code >= 161 && code <= 255) ? character : code === 9 ? "  " : "?";
  }
  return out;
}

function escapePdf(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Breaks one long line at spaces so it fits the page. */
export function wrapText(text: string, width: number = MAX_CHARS): string[] {
  const words = printable(text).split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    let rest = word;
    while (rest.length > width) {
      if (current) { lines.push(current); current = ""; }
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    if (!current) current = rest;
    else if (current.length + 1 + rest.length <= width) current += ` ${rest}`;
    else { lines.push(current); current = rest; }
  }
  lines.push(current);
  return lines;
}

/** Builds the PDF bytes: one text stream per page, objects numbered in order, a cross-reference table at the end. */
export function buildTextPdf(title: string, lines: readonly PdfLine[]): Uint8Array {
  const perPage = Math.floor((PAGE_HEIGHT - MARGIN * 2) / LEADING);
  const flat: PdfLine[] = [];
  for (const line of lines) {
    for (const piece of wrapText(line.text, line.heading ? 70 : MAX_CHARS)) flat.push({ text: piece, heading: line.heading });
  }
  const pages: PdfLine[][] = [];
  for (let index = 0; index < flat.length; index += perPage) pages.push(flat.slice(index, index + perPage));
  if (pages.length === 0) pages.push([{ text: "" }]);

  // 1 catalog, 2 pages, 3 regular font, 4 bold font, then a page and a content stream per page, then the info dictionary.
  const objects: string[] = [];
  const pageObjectNumbers = pages.map((_, index) => 5 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  pages.forEach((page, index) => {
    const pageNumber = 5 + index * 2;
    const streamNumber = pageNumber + 1;
    let content = "BT\n";
    let y = PAGE_HEIGHT - MARGIN;
    for (const line of page) {
      content += `/${line.heading ? "F2" : "F1"} ${line.heading ? FONT_SIZE + 2 : FONT_SIZE} Tf\n1 0 0 1 ${MARGIN} ${y} Tm\n(${escapePdf(printable(line.text))}) Tj\n`;
      y -= LEADING;
    }
    content += "ET";
    objects[pageNumber] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamNumber} 0 R >>`;
    objects[streamNumber] = `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
  });
  const infoNumber = 5 + pages.length * 2;
  objects[infoNumber] = `<< /Title (${escapePdf(printable(title))}) /Producer (Kalendr) >>`;

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let number = 1; number <= infoNumber; number += 1) {
    offsets[number] = Buffer.byteLength(body, "latin1");
    body += `${number} 0 obj\n${objects[number]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${infoNumber + 1}\n0000000000 65535 f \n`;
  for (let number = 1; number <= infoNumber; number += 1) body += `${String(offsets[number]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${infoNumber + 1} /Root 1 0 R /Info ${infoNumber} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
