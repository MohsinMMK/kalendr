import Papa from "papaparse";
import { describe, expect, it } from "vitest";

import { buildErrorCsv, neutraliseFormula } from "./errors-csv";
import { parseImportFile } from "./parse";
import { reasonText } from "./reasons";
import { importErrorCodes } from "./contracts";

describe("error file", () => {
  it("neutralises cells that would run as formulas", () => {
    expect(["=1+1", "+44 1", "-5", "@SUM(A1)", "\tx", "\rx", "plain", "a=b"].map(neutraliseFormula))
      .toEqual(["'=1+1", "'+44 1", "'-5", "'@SUM(A1)", "'\tx", "'\rx", "plain", "a=b"]);
  });

  it("keeps only the failed rows, with their original columns and a reason", async () => {
    const file = await parseImportFile(new TextEncoder().encode("Name,Phone\n=cmd|' /C calc'!A0,98450 12345\nGood,98450 12346\nBad,12\n"));
    const csv = buildErrorCsv("customers", file, [
      { rowNumber: 1, code: "invalid_email", field: "email" },
      { rowNumber: 3, code: "invalid_phone", field: "phone" },
    ]);
    const parsed = Papa.parse<string[]>(csv.replace(/^﻿/, ""), { skipEmptyLines: true }).data;
    expect(parsed[0]).toEqual(["Name", "Phone", "reason"]);
    expect(parsed).toHaveLength(3);
    expect(parsed[1]![0]).toBe("'=cmd|' /C calc'!A0");
    expect(parsed[2]!.slice(0, 2)).toEqual(["Bad", "12"]);
    expect(parsed[2]![2]).toMatch(/phone number/);
    expect(csv).not.toContain("Good");
  });

  it("has a plain reason for every code", () => {
    for (const code of importErrorCodes) expect(reasonText("customers", code, "phone").length).toBeGreaterThan(10);
  });
});
