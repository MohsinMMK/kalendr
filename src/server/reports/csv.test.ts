import { describe, expect, it } from "vitest";

import type { ReportResult } from "@/lib/reports";

import { csvText, reportToCsv } from "./csv";

const result: ReportResult = {
  report: "sources", range: { from: "2026-09-01", to: "2026-09-30" }, currency: "INR", scopedToPerson: false,
  metrics: [{ key: "revenue", label: "Revenue", value: 190000, previous: null, format: "money", formula: "Revenue: payments, less refunds." }],
  charts: [],
  tables: [{ key: "campaigns", title: "By campaign", columns: [{ key: "campaign", label: "Campaign", format: "text" }, { key: "total", label: "Bookings", format: "count" }, { key: "rate", label: "Rate", format: "percent" }],
    rows: [{ campaign: '=HYPERLINK("http://evil.example")', total: 3, rate: 12.5 }, { campaign: "Diwali, 2026", total: 1, rate: null }] }],
};

describe("report CSV", () => {
  it("opens cleanly in a spreadsheet: byte-order mark, CRLF, money in rupees", () => {
    const csv = reportToCsv(result);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.split("\r\n").length).toBeGreaterThan(5);
    expect(csv).not.toMatch(/[^\r]\n/);
    expect(csv).toContain("Revenue,1900.00,,");
  });

  it("never lets a campaign name run as a formula", () => {
    expect(csvText("=1+1")).toBe("'=1+1");
    expect(csvText("+91 98765")).toBe("'+91 98765");
    expect(csvText("-cmd")).toBe("'-cmd");
    expect(csvText("@SUM(A1)")).toBe("'@SUM(A1)");
    const csv = reportToCsv(result);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"")",3,12.5`);
  });

  it("quotes commas and leaves empty cells empty", () => {
    expect(reportToCsv(result)).toContain('"Diwali, 2026",1,');
  });
});
