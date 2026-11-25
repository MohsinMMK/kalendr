"use client";

import { Progress, ProgressIndicator, ProgressLabel, ProgressTrack } from "@/components/ui/progress";

/** One bar for the whole booking, counting only the screens this customer sees (`p-progress-3`). */
export function BookingProgress({ current, total }: { current: number; total: number }) {
  const label = `Step ${current} of ${total}`;
  return (
    <Progress
      value={current}
      max={total}
      getAriaValueText={() => label}
      className="gap-1.5"
    >
      <div className="flex items-center justify-between gap-2">
        <ProgressLabel className="font-medium text-muted-foreground text-xs tabular-nums">{label}</ProgressLabel>
      </div>
      <ProgressTrack className="h-1.5">
        <ProgressIndicator className="motion-safe:transition-all motion-safe:duration-300" />
      </ProgressTrack>
    </Progress>
  );
}
