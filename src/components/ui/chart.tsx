"use client";

import * as React from "react";
import { ResponsiveContainer, Tooltip, type TooltipContentProps } from "recharts";

import { cn } from "@/lib/utils";

/**
 * Charts, in coss's look: Recharts draws, these pieces dress it. Colours come from the theme's `--chart-*` tokens, so light and dark
 * both work; the tooltip is a coss popover surface. A chart is a picture of a table, so give every one a table view next to it.
 */
export const chartSeriesColors = ["var(--chart-2)", "var(--chart-1)", "var(--chart-3)", "var(--chart-4)"] as const;

export function ChartFrame({ label, height = 240, className, children }: { label: string; height?: number; className?: string; children: React.ReactElement }) {
  return (
    <div role="img" aria-label={label} className={cn("w-full text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line]:stroke-border/60 [&_.recharts-surface]:outline-none", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
    </div>
  );
}

/** The hover card for a chart. `format` writes a value the way the axis does (rupees, hours, percent). */
export function ChartTooltip({ format, labelFormat }: { format: (value: number, key: string) => string; labelFormat?: (label: string) => string }) {
  return <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.5 }} content={(props) => <ChartTooltipBody {...props} format={format} labelFormat={labelFormat} />} />;
}

function ChartTooltipBody({ active, payload, label, format, labelFormat }: TooltipContentProps & { format: (value: number, key: string) => string; labelFormat?: (label: string) => string }) {
  if (!active || !payload?.length) return null;
  const title = String(label ?? "");
  return (
    <div className="min-w-32 rounded-lg border bg-popover px-3 py-2 text-popover-foreground text-xs shadow-lg/5">
      <p className="mb-1 font-medium">{labelFormat ? labelFormat(title) : title}</p>
      <ul className="flex flex-col gap-0.5">
        {payload.map((item) => (
          <li key={String(item.dataKey)} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted-foreground"><span aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: item.color ?? item.payload?.fill }} />{item.name}</span>
            <span className="font-medium tabular-nums">{format(Number(item.value ?? 0), String(item.dataKey))}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
