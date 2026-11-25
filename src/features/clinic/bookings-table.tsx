"use client";

import { flexRender, useTable } from "@tanstack/react-table";
import { Ellipsis } from "lucide-react";
import { useRouter } from "next/navigation";
import { type MouseEvent, useMemo, useState } from "react";

import { ActionMenuButton, type ActionMenuEntry } from "@/components/action-bar";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { BookingColumn, BookingRow } from "@/lib/bookings-list";
import { appointmentLink } from "@/lib/staff-alerts";
import { cn } from "@/lib/utils";

import { ColumnHeaderMenu } from "@/components/reui/data-grid/data-grid-header-menu";

import { BookingStatus, bookingColumnDef, type BookingColumnDef, bookingTableFeatures, TimeLink } from "./bookings-columns";
import { AppointmentPopover, type VisitAnchor } from "./appointment-card";
import { appointmentDateTime } from "./clinic-format";
import { usePreviewAppointments } from "./preview-appointments";
import { ScrollArea } from "@/components/ui/scroll-area";

export interface BookingTableProps {
  rows: BookingRow[];
  columns: BookingColumn[];
  labels: Record<BookingColumn, string>;
  selected: ReadonlySet<string>;
  /** Show checkboxes and the ⋯ menu. Off for people who may not change bookings. */
  selectable: boolean;
  sort: "asc" | "desc";
  busy: boolean;
  onSort: () => void;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[], on: boolean) => void;
  menuFor: (row: BookingRow) => ActionMenuEntry[];
}

const interactive = "a,button,label,input,[role='checkbox'],[role='menuitem'],[role='combobox']";
const rowName = (row: BookingRow) => `${row.customer.name} at ${appointmentDateTime(row.startsAt)}`;

function RowCheckbox({ row, checked, onToggle }: { row: BookingRow; checked: boolean; onToggle: (id: string) => void }) {
  return (
    <label className="flex size-8 items-center justify-center pointer-coarse:size-11">
      <Checkbox checked={checked} onCheckedChange={() => onToggle(row.id)} aria-label={`Select ${rowName(row)}`} />
    </label>
  );
}

function RowMenu({ row, entries }: { row: BookingRow; entries: ActionMenuEntry[] }) {
  return <ActionMenuButton label={`Actions for ${rowName(row)}`} iconOnly variant="ghost" icon={<Ellipsis aria-hidden="true" />} items={entries} className="pointer-coarse:size-11" />;
}

/** The loading state: rows the shape of the real ones. */
export function BookingsSkeleton({ phone }: { phone: boolean }) {
  return (
    <div role="status" aria-label="Loading bookings" className="flex flex-col gap-px p-3">
      {Array.from({ length: phone ? 5 : 8 }, (_, index) => <Skeleton key={index} className={phone ? "h-20 w-full" : "h-11 w-full"} />)}
    </div>
  );
}

/** The bookings as a table, or as cards on a phone. Columns follow the person's choice; the table scrolls inside its box. */
export function BookingsTable(props: BookingTableProps & { phone: boolean }) {
  const { rows, columns, labels, selected, selectable, sort, busy, phone, onSort, onToggle, onToggleAll, menuFor } = props;
  const router = useRouter();
  const { appointments, patients, operations } = usePreviewAppointments();
  const [card, setCard] = useState<{ id: string; anchor: VisitAnchor } | null>(null);
  const shown = card ? appointments.find((item) => item.id === card.id) ?? null : null;
  // A click on a row, or a plain click on its time, opens the booking's card right here instead of leaving the page.
  // A modified click on the time still opens the link its own way, like a new tab.
  const open = (row: BookingRow) => (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    const timeLink = target.closest("a[data-time-link]");
    if (timeLink ? event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0 : target.closest(interactive)) return;
    if (!appointments.some((item) => item.id === row.id)) { router.push(appointmentLink(row.id)); return; }
    event.preventDefault();
    const element = event.currentTarget;
    const offset = event.detail > 0 ? event.clientX - element.getBoundingClientRect().left : 16;
    // Pointed at where the row was clicked, and kept on the row as the list scrolls.
    setCard({ id: row.id, anchor: { getBoundingClientRect: () => {
      const box = element.getBoundingClientRect();
      return new DOMRect(box.left + Math.min(offset, box.width - 8), box.top, 0, box.height);
    } } });
  };
  const cardPopover = <AppointmentPopover appointment={shown} anchor={card?.anchor ?? null} patients={patients} clockIso={operations.clockIso}
    started={Boolean(shown && operations.visitTimings[shown.id]?.startedAt)} context="from=bookings" side="bottom" onClose={() => setCard(null)} />;
  const allOn = rows.length > 0 && rows.every((row) => selected.has(row.id));
  const someOn = !allOn && rows.some((row) => selected.has(row.id));
  const toggleAll = () => onToggleAll(rows.map((row) => row.id), !allOn);

  const defs = useMemo<BookingColumnDef[]>(() => [
    ...(selectable ? [{ id: "select", header: () => null, cell: () => null } as BookingColumnDef] : []),
    ...columns.map((column) => bookingColumnDef(column)),
    ...(selectable ? [{ id: "actions", header: () => null, cell: () => null } as BookingColumnDef] : []),
  ], [columns, selectable]);
  const table = useTable({ features: bookingTableFeatures, columns: defs, data: rows, getRowId: (row: BookingRow) => row.id });

  if (phone) {
    return (<>
      <ul aria-label="Bookings" aria-busy={busy} className={cn("flex flex-col", busy && "opacity-60")}>
        {rows.map((row) => (
          <li key={row.id} data-state={selected.has(row.id) ? "selected" : undefined} onClickCapture={open(row)} data-open={card?.id === row.id ? "" : undefined} className="flex cursor-pointer items-start gap-1 border-b px-2 py-2 data-[state=selected]:bg-muted/64">
            {selectable ? <RowCheckbox row={row} checked={selected.has(row.id)} onToggle={onToggle} /> : null}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-1">
              <TimeLink row={row} />
              {columns.includes("customer") ? <span className="truncate text-sm">{row.customer.name}</span> : null}
              {columns.includes("service") || columns.includes("person") ? (
                <span className="truncate text-xs text-muted-foreground">{[columns.includes("service") ? row.service.name : null, columns.includes("person") ? row.practitioner.name : null].filter(Boolean).join(" · ")}</span>
              ) : null}
              {columns.includes("status") ? <span className="pt-1"><BookingStatus row={row} /></span> : null}
            </div>
            {selectable ? <RowMenu row={row} entries={menuFor(row)} /> : null}
          </li>
        ))}
      </ul>
      {cardPopover}
    </>);
  }

  return (<>
    <ScrollArea className="min-h-0 flex-1 [&_[data-slot=table-container]]:overflow-visible" clampContentMinWidth={false}>
      <Table aria-label="Bookings" aria-busy={busy} className={cn(busy && "opacity-60")}>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead key={header.id} scope="col" className="sticky top-0 z-10 bg-background">
                  {header.id === "select" ? (
                    <label className="flex size-8 items-center justify-center"><Checkbox checked={allOn} indeterminate={someOn} onCheckedChange={toggleAll} aria-label="Select all loaded bookings" /></label>
                  ) : header.id === "actions" ? <span className="sr-only">Actions</span> : (
                    // Only Time sorts (the list is sorted by the server); the menu offers the rest for every column.
                    <ColumnHeaderMenu
                      id={header.id}
                      title={labels[header.id as BookingColumn]}
                      sort={header.id === "time" ? { direction: sort, set: (direction) => { if (direction && direction !== sort) onSort(); } } : undefined}
                    />
                  )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id} data-state={selected.has(row.id) ? "selected" : undefined} data-open={card?.id === row.original.id ? "" : undefined} className="cursor-pointer data-open:bg-accent/60 data-[state=selected]:bg-muted/64" onClickCapture={open(row.original)}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id} className={cn(cell.column.id === "actions" && "w-12 text-end")}>
                  {cell.column.id === "select" ? <RowCheckbox row={row.original} checked={selected.has(row.id)} onToggle={onToggle} />
                    : cell.column.id === "actions" ? <RowMenu row={row.original} entries={menuFor(row.original)} />
                    : flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollArea>
    {cardPopover}
  </>);
}
