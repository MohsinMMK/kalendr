import { reportLabels, type MetricFormat, type ReportResult } from "../../lib/reports";

/**
 * A report as a CSV a spreadsheet opens cleanly: a UTF-8 byte-order mark (so Excel reads rupee signs and accents), CRLF line
 * ends, RFC 4180 quoting, money in major units and percents as plain numbers. Text that starts with = + - @ (a campaign name or
 * a customer's name can be anything) gets a leading apostrophe so it can never run as a formula.
 */
export function csvText(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function csvValue(value: string | number | null, format: MetricFormat | "text" | "date" | undefined): string {
  if (value === null) return "";
  if (typeof value === "string") return csvText(value);
  if (format === "money") return (value / 100).toFixed(2);
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

export function reportToCsv(result: ReportResult): string {
  const lines: string[] = [];
  const push = (cells: string[]) => lines.push(cells.join(","));
  push([csvText(reportLabels[result.report]), csvText(`${result.range.from} to ${result.range.to}`)]);
  if (result.metrics.length > 0) {
    push([]);
    push(["Figure", "Value", "Before", "How it is worked out"].map(csvText));
    for (const metric of result.metrics) {
      push([csvText(metric.label), csvValue(metric.value, metric.format), csvValue(metric.previous ?? null, metric.format), csvText(metric.formula)]);
    }
  }
  for (const chart of result.charts.filter((item) => item.kind !== "heat")) {
    push([]);
    push([csvText(chart.title)]);
    push([csvText(chart.xKey), ...chart.series.map((series) => csvText(series.label))]);
    for (const row of chart.rows) push([csvValue(String(row[chart.xKey] ?? ""), "text"), ...chart.series.map((series) => csvValue(row[series.key] ?? null, series.format))]);
  }
  for (const table of result.tables) {
    push([]);
    push([csvText(table.title)]);
    push(table.columns.map((column) => csvText(column.label)));
    for (const row of table.rows) push(table.columns.map((column) => csvValue(row[column.key] ?? null, column.format)));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

export function reportFilename(report: string, from: string, to: string): string {
  return `kalendr-${report}-${from}-to-${to}.csv`;
}
