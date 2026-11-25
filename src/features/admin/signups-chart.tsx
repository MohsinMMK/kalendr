"use client";

import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import type { AdminSignupDay } from "@/lib/admin-contracts";

import { ErrorPanel, LoadingRows } from "./screen-states";
import { useSignups } from "./admin-api";

const dayFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });

/** Bars for each day, drawn in plain SVG in the primary colour. The summary line is the accessible version. */
export function SignupBars({ days }: { days: AdminSignupDay[] }) {
  const max = Math.max(1, ...days.map((entry) => entry.signups));
  const total = days.reduce((sum, entry) => sum + entry.signups, 0);
  const busiest = days.reduce<AdminSignupDay | null>((best, entry) => (!best || entry.signups > best.signups ? entry : best), null);
  const width = 600;
  const height = 80;
  const slot = width / Math.max(1, days.length);
  const summary = busiest && total > 0
    ? `${total} sign-ups in the last ${days.length} days. The most in one day was ${busiest.signups}, on ${dayFormat.format(new Date(busiest.day))}.`
    : `No sign-ups in the last ${days.length} days.`;
  return (
    <figure className="flex flex-col gap-2">
      <svg role="img" aria-label={summary} viewBox={`0 0 ${width} ${height}`} className="h-24 w-full text-primary" preserveAspectRatio="none">
        <line x1="0" x2={width} y1={height - 0.5} y2={height - 0.5} className="stroke-border" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {days.map((entry, index) => {
          const barHeight = entry.signups === 0 ? 0 : Math.max(3, (entry.signups / max) * (height - 4));
          return (
            <rect key={entry.day} x={index * slot + slot * 0.15} y={height - barHeight} width={slot * 0.7} height={barHeight} rx="1.5" fill="currentColor">
              <title>{`${dayFormat.format(new Date(entry.day))}: ${entry.signups}`}</title>
            </rect>
          );
        })}
      </svg>
      <figcaption className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>{days[0] ? dayFormat.format(new Date(days[0].day)) : ""}</span>
        <span>{summary}</span>
        <span>{days.at(-1) ? dayFormat.format(new Date(days[days.length - 1].day)) : ""}</span>
      </figcaption>
    </figure>
  );
}

export function SignupsPanel({ days = 30 }: { days?: number }) {
  const query = useSignups(days);
  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>New businesses</FrameTitle>
        <FrameDescription>Sign-ups per day over the last {days} days.</FrameDescription>
      </FrameHeader>
      <FramePanel>
        {query.isPending ? <LoadingRows label="Loading sign-ups" rows={1} /> : null}
        {query.isError ? <ErrorPanel error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} /> : null}
        {query.data ? <SignupBars days={query.data} /> : null}
      </FramePanel>
    </Frame>
  );
}
