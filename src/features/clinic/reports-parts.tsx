"use client";

import { ArrowDownRight, ArrowUpRight, ChevronRight, Minus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";

import { ChartFrame, chartSeriesColors, ChartTooltip } from "@/components/ui/chart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { changeFrom, formatReportValue, type MetricFormat, type ReportChart, type ReportMetric, type ReportTable } from "@/lib/reports";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

const shortDay = (value: string) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }) : value);

/** One headline figure: the number, how it moved against the period before, how it is worked out, and a way to check it. */
export function MetricCard({ metric, currency }: { metric: ReportMetric; currency: string }) {
  const change = changeFrom(metric.value, metric.previous);
  const Arrow = change === null || change === 0 ? Minus : change > 0 ? ArrowUpRight : ArrowDownRight;
  // For rates where less is better the arrow still shows the direction; the words carry the meaning.
  return (
    <Card className="min-w-0">
      <CardContent className="flex flex-col gap-1 p-4">
        <p className="text-muted-foreground text-sm">{metric.label}</p>
        <p className="font-semibold text-2xl tabular-nums" data-testid={`metric-${metric.key}`}>{formatReportValue(metric.value, metric.format, currency)}</p>
        {metric.previous !== undefined ? (
          <p className="flex items-center gap-1 text-muted-foreground text-xs">
            <Arrow aria-hidden="true" className="size-3.5" />
            <span>{change === null ? "No earlier figure to compare" : `${change > 0 ? "Up" : change < 0 ? "Down" : "Same as"} ${change === 0 ? "" : `${Math.abs(change)}% `}${change === 0 ? "the period before" : "on the period before"}`}</span>
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs">{metric.formula}</p>
        {metric.href ? <Link href={metric.href} className="mt-1 inline-flex min-h-11 items-center gap-0.5 font-medium text-primary text-xs underline-offset-4 hover:underline sm:min-h-6">See the rows<ChevronRight aria-hidden="true" className="size-3.5" /></Link> : null}
      </CardContent>
    </Card>
  );
}

/** A data table in coss's table. Rows that carry a link open the bookings (or customer) behind them. */
export function DataTable({ table, currency }: { table: Pick<ReportTable, "columns" | "rows" | "hrefKey">; currency: string }) {
  return (
    <ScrollArea clampContentMinWidth={false}>
      <Table render={<div className="relative w-full overflow-visible!" />}>
        <TableHeader>
          <TableRow>{table.columns.map((column, index) => <TableHead key={column.key} className={index === 0 ? undefined : "text-right"}>{column.label}</TableHead>)}{table.hrefKey ? <TableHead className="w-10"><span className="sr-only">Rows behind it</span></TableHead> : null}</TableRow>
        </TableHeader>
        <TableBody>
          {table.rows.length === 0 ? <TableRow><TableCell colSpan={table.columns.length + 1} className="text-center text-muted-foreground">Nothing in this period.</TableCell></TableRow> : null}
          {table.rows.map((row, rowIndex) => (
            <TableRow key={rowIndex}>
              {table.columns.map((column, index) => <TableCell key={column.key} className={cn(index === 0 ? "font-medium" : "text-right tabular-nums")}>{formatReportValue(row[column.key] ?? null, column.format, currency)}</TableCell>)}
              {table.hrefKey ? <TableCell>{typeof row[table.hrefKey] === "string" ? <Link href={String(row[table.hrefKey])} aria-label={`See the rows for ${String(row[table.columns[0]?.key ?? ""] ?? "this row")}`} className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent sm:size-8"><ChevronRight aria-hidden="true" className="size-4" /></Link> : null}</TableCell> : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}

export function TableCard({ table, currency }: { table: ReportTable; currency: string }) {
  return (
    <Card className="min-w-0">
      <CardHeader><CardTitle className="text-base">{table.title}</CardTitle>{table.note ? <p className="text-muted-foreground text-xs">{table.note}</p> : null}</CardHeader>
      <CardContent className="p-0 pb-2"><DataTable table={table} currency={currency} /></CardContent>
    </Card>
  );
}

function BarView({ chart, currency }: { chart: ReportChart; currency: string }) {
  const series = chart.series[0]!;
  const format = (value: number) => formatReportValue(value, series.format, currency);
  const color = chartSeriesColors[0];
  return (
    <ChartFrame label={`${chart.title}: ${chart.rows.length} values, also shown as a table`}>
      <BarChart data={chart.rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey={chart.xKey} tickLine={false} axisLine={false} tickFormatter={shortDay} interval="preserveStartEnd" minTickGap={16} />
        <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(value: number) => (series.format === "money" ? `${Math.round(value / 100000) / 10}k` : String(value))} />
        <ChartTooltip format={(value) => format(value)} labelFormat={shortDay} />
        <Bar dataKey={series.key} name={series.label} fill={color} radius={[4, 4, 0, 0]} maxBarSize={36}>
          {chart.rows.map((row, index) => <Cell key={index} fill={color} aria-label={`${String(row[chart.xKey])}: ${format(Number(row[series.key] ?? 0))}`} />)}
        </Bar>
      </BarChart>
    </ChartFrame>
  );
}

/** Weekday by hour. Darker means busier; the number is in each cell for people who cannot tell the shades apart. */
function HeatGrid({ chart }: { chart: ReportChart }) {
  const max = Math.max(1, ...chart.rows.flatMap((row) => chart.series.map((series) => Number(row[series.key] ?? 0))));
  const hours = chart.series.map((series, index) => ({ ...series, index })).filter((series) => chart.rows.some((row) => Number(row[series.key] ?? 0) > 0));
  const shown = hours.length > 0 ? hours : chart.series.map((series, index) => ({ ...series, index })).slice(8, 18);
  return (
    <ScrollArea clampContentMinWidth={false}>
      <table className="w-full border-separate border-spacing-0.5 text-xs" aria-label={chart.title}>
        <thead><tr><th className="w-10" />{shown.map((hour) => <th key={hour.key} scope="col" className="min-w-8 font-normal text-muted-foreground">{hour.index}</th>)}</tr></thead>
        <tbody>
          {chart.rows.map((row) => (
            <tr key={String(row[chart.xKey])}>
              <th scope="row" className="pe-2 text-start font-normal text-muted-foreground">{String(row[chart.xKey])}</th>
              {shown.map((hour) => {
                const value = Number(row[hour.key] ?? 0);
                return <td key={hour.key} title={`${row[chart.xKey]} ${hour.label}: ${value}`} className="h-8 rounded-sm text-center tabular-nums" style={{ background: value ? `color-mix(in oklab, var(--chart-2) ${Math.round(12 + (value / max) * 78)}%, transparent)` : "var(--muted)" }}>{value || ""}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function chartTable(chart: ReportChart): Pick<ReportTable, "columns" | "rows"> {
  if (chart.kind === "heat") {
    const hours = chart.series.filter((series) => chart.rows.some((row) => Number(row[series.key] ?? 0) > 0));
    return { columns: [{ key: chart.xKey, label: "Day" }, ...hours.map((series) => ({ key: series.key, label: series.label, format: "count" as MetricFormat }))], rows: chart.rows };
  }
  return { columns: [{ key: chart.xKey, label: chart.xKey === "day" ? "Day" : "Group", format: "text" }, ...chart.series.map((series) => ({ key: series.key, label: series.label, format: series.format ?? ("count" as MetricFormat) }))], rows: chart.rows };
}

/** A chart with its table beside it: the table is what a screen reader and a printout use. */
export function ChartCard({ chart, currency }: { chart: ReportChart; currency: string }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const empty = chart.rows.length === 0 || chart.rows.every((row) => chart.series.every((series) => !row[series.key]));
  return (
    <Card className="min-w-0">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{chart.title}</CardTitle>
        <Tabs value={view} onValueChange={(next) => setView(next === "table" ? "table" : "chart")} className="gap-0">
          <TabsList aria-label={`${chart.title} view`}><TabsTrigger value="chart" className="min-h-11 sm:min-h-7">Chart</TabsTrigger><TabsTrigger value="table" className="min-h-11 sm:min-h-7">Table</TabsTrigger></TabsList>
        </Tabs>
      </CardHeader>
      <CardContent>
        {view === "table" ? <DataTable table={chartTable(chart)} currency={currency} /> : empty ? <p className="py-10 text-center text-muted-foreground text-sm">Nothing in this period.</p> : chart.kind === "heat" ? <HeatGrid chart={chart} /> : <BarView chart={chart} currency={currency} />}
      </CardContent>
    </Card>
  );
}
