/**
 * The Notion-style value a property row shows: full width, quiet until hovered, highlighted while its
 * popup is open. Shared by the select, date and number editors so every property looks the same.
 */
export const inlineTriggerClass =
  "group -mx-1.5 flex h-7 w-[calc(100%+--spacing(3))] min-w-0 items-center gap-1.5 rounded-md px-1.5 text-start text-sm outline-none enabled:hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/24 disabled:cursor-default data-popup-open:bg-accent";

/**
 * Turns a coss Input or Textarea (size "sm") into a Notion-style value: no border until focused, a quiet
 * hover, and the same left edge as the select and date values beside it.
 */
export const inlineInputClass =
  "-mx-1.5 w-[calc(100%+--spacing(3))] rounded-md border-transparent bg-transparent shadow-none before:hidden not-has-focus-visible:not-has-disabled:hover:bg-accent has-focus-visible:bg-background has-disabled:opacity-100 dark:bg-transparent *:data-[slot=input]:px-[calc(--spacing(1.5)-1px)] *:data-[slot=textarea]:px-[calc(--spacing(1.5)-1px)] *:data-[slot=textarea]:min-h-7 *:data-[slot=textarea]:resize-none *:data-[slot=textarea]:leading-5";
