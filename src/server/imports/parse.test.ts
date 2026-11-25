import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";

import { importLimits } from "./contracts";
import { ImportParseError, parseImportFile, sniffFormat } from "./parse";
import { makeXlsx } from "./testing/xlsx-fixture";

const text = (value: string) => new TextEncoder().encode(value);

async function codeOf(bytes: Uint8Array): Promise<string> {
  try {
    await parseImportFile(bytes);
    return "ok";
  } catch (error) {
    return error instanceof ImportParseError ? error.code : "other";
  }
}

describe("CSV", () => {
  it("reads plain comma files", async () => {
    const file = await parseImportFile(text("Name,Phone\nAsha,98765 43210\nRavi,91234 56780\n"));
    expect(file.format).toBe("csv");
    expect(file.headers).toEqual(["Name", "Phone"]);
    expect(file.rows).toEqual([["Asha", "98765 43210"], ["Ravi", "91234 56780"]]);
  });

  it("drops a UTF-8 byte order mark so the first header is clean", async () => {
    const file = await parseImportFile(text("﻿Name,Phone\nAsha,1\n"));
    expect(file.headers[0]).toBe("Name");
  });

  it.each([[";"], ["\t"], ["|"]])("guesses the %j delimiter", async (delimiter) => {
    const file = await parseImportFile(text(`Name${delimiter}Phone${delimiter}City\nAsha${delimiter}111${delimiter}Pune\n`));
    expect(file.headers).toEqual(["Name", "Phone", "City"]);
    expect(file.rows[0]).toEqual(["Asha", "111", "Pune"]);
  });

  it("keeps quoted commas and newlines inside one cell", async () => {
    const file = await parseImportFile(text('Name,Notes\n"Asha ""A"" Rao","line one\nline two, with comma"\nRavi,plain\n'));
    expect(file.rows).toHaveLength(2);
    expect(file.rows[0]).toEqual(['Asha "A" Rao', "line one\nline two, with comma"]);
  });

  it("falls back to Windows-1252 for accented names saved by Excel", async () => {
    const bytes = Uint8Array.from([...text("Name,City\n"), 0x4a, 0x6f, 0x73, 0xe9, 0x2c, 0x50, 0x75, 0x6e, 0x65, 0x0a]);
    const file = await parseImportFile(bytes);
    expect(file.rows[0]![0]).toBe("José");
  });

  it("pads short rows, trims cells, truncates a very long cell and skips blank lines", async () => {
    const long = "x".repeat(importLimits.maxCellLength + 500);
    const file = await parseImportFile(text(`A,B,C\n  one  ,two\n\n,,\n${long},y,z\n`));
    expect(file.rows[0]).toEqual(["one", "two", ""]);
    expect(file.rows).toHaveLength(2);
    expect(file.rows[1]![0]).toHaveLength(importLimits.maxCellLength);
  });

  it("names a blank header cell", async () => {
    const file = await parseImportFile(text("Name,,Phone\nAsha,x,1\n"));
    expect(file.headers).toEqual(["Name", "Column 2", "Phone"]);
  });
});

describe("limits and refusals", () => {
  it("refuses files over 10 MB without reading them", async () => {
    expect(await codeOf(new Uint8Array(importLimits.maxBytes + 1).fill(97))).toBe("file_too_large");
  });

  it("refuses more than 20,000 data rows", async () => {
    const rows = Array.from({ length: importLimits.maxRows + 1 }, (_, index) => `n${index},1`);
    expect(await codeOf(text(`Name,Phone\n${rows.join("\n")}`))).toBe("too_many_rows");
    expect(await codeOf(text(`Name,Phone\n${rows.slice(0, importLimits.maxRows).join("\n")}`))).toBe("ok");
  });

  it("refuses more than 60 columns", async () => {
    const header = Array.from({ length: 61 }, (_, index) => `c${index}`).join(",");
    expect(await codeOf(text(`${header}\n${"1,".repeat(60)}1\n`))).toBe("too_many_columns");
  });

  it("calls an empty file empty, and a header-only file empty", async () => {
    expect(await codeOf(new Uint8Array())).toBe("empty_file");
    expect(await codeOf(text("\n\n  \n"))).toBe("empty_file");
    expect(await codeOf(text("Name,Phone\n"))).toBe("empty_file");
  });

  it("calls a file whose first row is data a file with no header", async () => {
    expect(await codeOf(text("98765 43210,12/03/1990\n91234 56780,01/01/1980\n"))).toBe("no_header");
  });

  it("refuses binary files that are not zips", async () => {
    expect(await codeOf(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0x01, 0x02]))).toBe("unreadable_file");
    expect(() => sniffFormat(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toThrow(ImportParseError);
  });

  it("refuses an unterminated quote instead of swallowing the rest of the file", async () => {
    expect(await codeOf(text('Name,Phone\n"Asha,1\nRavi,2\n'))).toBe("unreadable_file");
  });

  it("decides the format from the bytes, not a name", () => {
    expect(sniffFormat(makeXlsx([["a"], ["b"]]))).toBe("xlsx");
    expect(sniffFormat(text("a,b\n1,2\n"))).toBe("csv");
  });
});

describe("XLSX", () => {
  it("reads the first sheet, numbers as text and date cells as ISO dates", async () => {
    const file = await parseImportFile(makeXlsx([
      ["Name", "Phone", "Date of birth"],
      ["Asha", 9876543210, { date: 32946 }],
      ["Ravi", "91234 56780", { date: 45000.5 }],
    ]));
    expect(file.format).toBe("xlsx");
    expect(file.headers).toEqual(["Name", "Phone", "Date of birth"]);
    expect(file.rows[0]).toEqual(["Asha", "9876543210", "1990-03-14"]);
    expect(file.rows[1]![2]).toBe("2023-03-15 12:00");
  });

  it("refuses a macro-enabled workbook", async () => {
    const bytes = makeXlsx([["Name"], ["Asha"]], { "xl/vbaProject.bin": strToU8("not really a macro") });
    expect(await codeOf(bytes)).toBe("macros_not_allowed");
  });

  it("refuses a zip that expands past the safe size", async () => {
    const bomb = zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "xl/big.xml": new Uint8Array(90 * 1024 * 1024) });
    expect(bomb.length).toBeLessThan(importLimits.maxBytes);
    expect(await codeOf(bomb)).toBe("unreadable_file");
  });

  it("refuses a zip that is not a workbook", async () => {
    expect(await codeOf(zipSync({ "hello.txt": strToU8("hi") }))).toBe("unreadable_file");
  });

  it("refuses a truncated spreadsheet", async () => {
    expect(await codeOf(makeXlsx([["a"], ["b"]]).subarray(0, 120))).toBe("unreadable_file");
  });
});
