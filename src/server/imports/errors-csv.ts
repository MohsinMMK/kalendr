import Papa from "papaparse";

import type { ImportErrorCode, ImportKind } from "./contracts";
import type { ParsedFile } from "./parse";
import { reasonText } from "./reasons";

/**
 * The error file: the rows that failed, with their original columns and one more column saying why. A cell that starts
 * with = + - @ or a tab or return would run as a formula in a spreadsheet, so it gets a single quote in front.
 */

export function neutraliseFormula(cell: string): string {
  return /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
}

export interface FailedRow {
  rowNumber: number;
  code: ImportErrorCode | null;
  field: string | null;
}

export function buildErrorCsv(kind: ImportKind, file: ParsedFile, failed: readonly FailedRow[]): string {
  const lines: string[][] = [[...file.headers, "reason"].map(neutraliseFormula)];
  for (const row of failed) {
    const original = file.rows[row.rowNumber - 1];
    if (!original) continue;
    lines.push([...original.map(neutraliseFormula), reasonText(kind, row.code, row.field)]);
  }
  // A byte order mark lets Excel open accented names correctly.
  return `﻿${Papa.unparse(lines, { newline: "\r\n" })}\r\n`;
}
