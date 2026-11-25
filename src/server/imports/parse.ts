import { unzipSync } from "fflate";
import Papa from "papaparse";
import { readSheet } from "read-excel-file/node";

import { importLimits, type ImportFileErrorCode } from "./contracts";

/**
 * Reads an uploaded customer, service or appointment file into plain text cells. The kind of file is decided from its
 * bytes (a zip header means a spreadsheet; otherwise it must be text), never from its name. Nothing here keeps or logs a
 * cell: callers get the cells and decide.
 */

export class ImportParseError extends Error {
  readonly code: ImportFileErrorCode;
  constructor(code: ImportFileErrorCode) {
    super(code);
    this.name = "ImportParseError";
    this.code = code;
  }
}

export interface ParsedFile {
  format: "csv" | "xlsx";
  headers: string[];
  /** Every data row, each exactly as wide as `headers`. */
  rows: string[][];
}

/** The most a spreadsheet may expand to once unzipped, and how many parts it may have. Stops zip bombs. */
const MAX_UNZIPPED_BYTES = 80 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 300;

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export function sniffFormat(bytes: Uint8Array): "csv" | "xlsx" {
  if (bytes.length >= 4 && ZIP_MAGIC.every((byte, index) => bytes[index] === byte)) return "xlsx";
  // Text has no NUL bytes. A PDF, image or old .xls binary almost always has one early on.
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) throw new ImportParseError("unreadable_file");
  return "csv";
}

function cleanCell(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > importLimits.maxCellLength ? trimmed.slice(0, importLimits.maxCellLength) : trimmed;
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes).replace(/^﻿/, "");
  } catch {
    // Excel on Windows saves "CSV" in the local code page. Accented names should survive, not fail the upload.
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function widen(rows: string[][], width: number): string[][] {
  return rows.map((row) => {
    const next = row.slice(0, width).map(cleanCell);
    while (next.length < width) next.push("");
    return next;
  });
}

function shape(format: "csv" | "xlsx", table: string[][]): ParsedFile {
  const rows = table.filter((row) => row.some((cell) => cell.trim() !== ""));
  if (rows.length === 0) throw new ImportParseError("empty_file");
  const head = rows[0]!;
  const lastFilled = head.reduce((last, cell, index) => (cell.trim() !== "" ? index : last), -1);
  if (lastFilled < 0) throw new ImportParseError("no_header");
  const width = lastFilled + 1;
  if (width > importLimits.maxColumns) throw new ImportParseError("too_many_columns");
  const headers = widen([head], width)[0]!.map((cell, index) => cell || `Column ${index + 1}`);
  // A first row where every cell looks like data (a number or a date) means the file has no header line.
  if (headers.every((cell) => /^[\d\s+()./:-]+$/.test(cell))) throw new ImportParseError("no_header");
  const data = rows.slice(1);
  if (data.length === 0) throw new ImportParseError("empty_file");
  if (data.length > importLimits.maxRows) throw new ImportParseError("too_many_rows");
  return { format, headers, rows: widen(data, width) };
}

function parseCsv(bytes: Uint8Array): ParsedFile {
  const text = decodeText(bytes);
  const result = Papa.parse<string[]>(text, { delimiter: "", delimitersToGuess: [",", ";", "\t", "|"], skipEmptyLines: "greedy" });
  // An unterminated quote swallows the rest of the file; refuse rather than import half of it as one cell.
  if (result.errors.some((error) => error.type === "Quotes")) throw new ImportParseError("unreadable_file");
  return shape("csv", result.data.map((row) => row.map((cell) => String(cell ?? ""))));
}

function checkSpreadsheetSafety(bytes: Uint8Array): void {
  let total = 0;
  let entries = 0;
  let macros = false;
  let looksLikeWorkbook = false;
  try {
    unzipSync(bytes, {
      filter(file) {
        entries += 1;
        total += file.originalSize;
        if (file.name === "[Content_Types].xml") looksLikeWorkbook = true;
        if (/vbaProject\.bin$/i.test(file.name)) macros = true;
        // Read nothing: only the sizes and names in the zip directory are needed.
        return false;
      },
    });
  } catch {
    throw new ImportParseError("unreadable_file");
  }
  if (macros) throw new ImportParseError("macros_not_allowed");
  if (!looksLikeWorkbook || entries > MAX_ZIP_ENTRIES || total > MAX_UNZIPPED_BYTES) throw new ImportParseError("unreadable_file");
}

const pad = (value: number) => String(value).padStart(2, "0");

/** A date cell as text. A time-only cell (Excel's day zero) is "HH:mm"; a date at midnight is just the date. */
function formatDateCell(value: Date): string {
  if (Number.isNaN(value.getTime())) return "";
  const year = value.getUTCFullYear();
  const time = `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}`;
  if (year < 1900) return time;
  const date = `${String(year).padStart(4, "0")}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  return time === "00:00" ? date : `${date} ${time}`;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return formatDateCell(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

async function parseXlsx(bytes: Uint8Array): Promise<ParsedFile> {
  checkSpreadsheetSafety(bytes);
  let table: unknown[][];
  try {
    // Values, not formulas: the library returns what each cell shows. Only the first sheet is read.
    table = (await readSheet(Buffer.from(bytes), 1, { trim: true })) as unknown[][];
  } catch {
    throw new ImportParseError("unreadable_file");
  }
  return shape("xlsx", table.map((row) => row.map(cellText)));
}

export async function parseImportFile(bytes: Uint8Array): Promise<ParsedFile> {
  if (bytes.length === 0) throw new ImportParseError("empty_file");
  if (bytes.length > importLimits.maxBytes) throw new ImportParseError("file_too_large");
  return sniffFormat(bytes) === "xlsx" ? parseXlsx(bytes) : parseCsv(bytes);
}
