import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * What the schedule looks like before its data arrives. It uses the same frame, header, toolbar and row heights as
 * the real screen, so nothing moves when the visits appear.
 */
export function ScheduleSkeleton({ label }: { label: string }) {
  return <div role="status" className="flex h-[calc(100svh-3.5rem)] min-h-[36rem] flex-col gap-4 p-4 max-sm:pb-24 md:p-6 lg:h-full lg:py-4">
    <span className="sr-only">{label}</span>
    <div aria-hidden="true" className="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-5 w-64 max-w-full" />
      </div>
      <Skeleton className="h-8 w-40" />
    </div>
    <Card aria-hidden="true" className="min-h-0 flex-1 overflow-hidden">
      <div className="flex size-full min-h-0 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2">
          <Skeleton className="h-9 w-40 sm:h-8" />
          <Skeleton className="h-9 w-44 sm:h-8" />
          <Skeleton className="h-9 w-80 max-w-full sm:h-8" />
          <div className="flex flex-1 items-center justify-end gap-2">
            <Skeleton className="h-9 w-full sm:h-8 sm:w-52" />
            <Skeleton className="h-9 w-24 max-sm:hidden sm:h-8" />
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-7 shrink-0 border-b">
            <div className="w-[8.5rem] shrink-0 border-e max-sm:hidden" />
            <div className="flex flex-1 items-center gap-16 overflow-hidden px-3">{Array.from({ length: 10 }, (_, index) => <Skeleton key={index} className="h-3 w-10 shrink-0" />)}</div>
          </div>
          {Array.from({ length: 4 }, (_, row) => (
            <div key={row} className="flex h-14 shrink-0 items-center border-b">
              <div className="flex w-[8.5rem] shrink-0 flex-col gap-1.5 border-e px-3 max-sm:hidden"><Skeleton className="h-3.5 w-24" /><Skeleton className="h-3 w-16" /></div>
              <div className="flex flex-1 items-center gap-6 overflow-hidden px-3 max-sm:flex-col max-sm:items-stretch max-sm:gap-2">
                {Array.from({ length: 5 }, (_, block) => <Skeleton key={block} className="h-7 w-24 shrink-0 max-sm:w-full" style={{ marginInlineStart: (block * (row + 1) * 7) % 24 }} />)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  </div>;
}
