"use client";

import { Check, X } from "lucide-react";

import { PersonAvatar } from "@/components/person-avatar";
import { Badge } from "@/components/ui/badge";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { TogglePrimitive } from "@/components/ui/toggle";
import { ToggleGroupPrimitive } from "@/components/ui/toggle-group";
import type { RosterEntry } from "@/lib/classes-contracts";

const sourceLabel: Record<RosterEntry["source"], string> = { online: "", staff: "Added by staff", walk_in: "Walk-in" };

/** One person with a seat: their name and a one-tap Present / Absent pair. Tapping the chosen one again undoes it. */
export function RosterRow({ entry, busy, disabled, onMark }: { entry: RosterEntry; busy: boolean; disabled: boolean; onMark: (outcome: "attended" | "no_show" | "booked") => void }) {
  const value = entry.status === "attended" ? "attended" : entry.status === "no_show" ? "no_show" : "";
  const offered = entry.status === "waitlisted";
  return (
    <li className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-3 py-2">
      <span className="flex min-w-0 items-center gap-2">
        <PersonAvatar name={entry.name} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{entry.name}</span>
          {sourceLabel[entry.source] ? <span className="text-xs text-muted-foreground">{sourceLabel[entry.source]}</span> : null}
        </span>
      </span>
      {offered ? <Badge variant="warning" size="lg">Offered a seat</Badge> : (
        <SegmentedControl
          className="shrink-0"
          render={
            <ToggleGroupPrimitive
              aria-label={`Attendance for ${entry.name}`}
              value={value ? [value] : []}
              disabled={disabled || busy}
              onValueChange={(next: string[]) => {
                const chosen = next[0];
                onMark(chosen === "attended" || chosen === "no_show" ? chosen : "booked");
              }}
            />
          }
        >
          <SegmentedControlItem className="min-h-11 min-w-20 sm:min-h-8" render={<TogglePrimitive value="attended" aria-label={`Present: ${entry.name}`} />}><Check aria-hidden="true" /> Present</SegmentedControlItem>
          <SegmentedControlItem className="min-h-11 min-w-20 sm:min-h-8" render={<TogglePrimitive value="no_show" aria-label={`Absent: ${entry.name}`} />}><X aria-hidden="true" /> Absent</SegmentedControlItem>
        </SegmentedControl>
      )}
    </li>
  );
}
