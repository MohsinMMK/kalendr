"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Previous and next buttons around the name of the period being shown. */
export function PeriodNav({ label, previousLabel, nextLabel, canPrevious, canNext, onPrevious, onNext, status }: {
  label: string;
  previousLabel: string;
  nextLabel: string;
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  status?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Button variant="outline" size="icon" className="min-h-11 min-w-11" aria-label={previousLabel} disabled={!canPrevious} onClick={onPrevious}>
        <ChevronLeft aria-hidden="true" />
      </Button>
      <div className="min-w-0 text-center">
        <p className="truncate font-medium text-sm">{label}</p>
        {status ? <p className="text-muted-foreground text-xs">{status}</p> : null}
      </div>
      <Button variant="outline" size="icon" className="min-h-11 min-w-11" aria-label={nextLabel} disabled={!canNext} onClick={onNext}>
        <ChevronRight aria-hidden="true" />
      </Button>
    </div>
  );
}
