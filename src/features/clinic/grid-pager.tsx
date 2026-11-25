"use client";

import { Button } from "@/components/ui/button";
import { Pagination, PaginationContent, PaginationItem, PaginationNext, PaginationPrevious } from "@/components/ui/pagination";

/** Previous and next for the phone card list, where the grid's own pager would be too wide. */
export function MobilePager({ label, page, pageCount, onPage }: {
  label: string;
  /** Starts at 1. */
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <>
      <p className="text-xs text-muted-foreground tabular-nums">Page {page} of {pageCount}</p>
      <Pagination aria-label={label} className="mx-0 w-auto">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious render={<Button size="sm" variant="ghost" disabled={page === 1} onClick={() => onPage(page - 1)} />} />
          </PaginationItem>
          <PaginationItem>
            <PaginationNext render={<Button size="sm" variant="ghost" disabled={page === pageCount} onClick={() => onPage(page + 1)} />} />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </>
  );
}
