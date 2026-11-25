"use client";

import { type ColumnDef, columnOrderingFeature, columnVisibilityFeature, tableFeatures } from "@tanstack/react-table";
import Link from "next/link";

import { StatusBadge } from "@/components/status-badge";
import { type BookingColumn, type BookingRow, bookingColumns, bookingSourceLabels, defaultBookingColumns } from "@/lib/bookings-list";
import type { GridColumnSpec } from "@/lib/grid-columns";
import { formatMoney } from "@/lib/money";
import { appointmentLink } from "@/lib/staff-alerts";
import type { TermWords } from "@/lib/terminology";

import { appointmentDateTime, statusLabel } from "./clinic-format";
import { CustomerLink, PractitionerLink, ServiceLink } from "./entity-links";
import { appointmentStatusTone } from "./task-ui";

export const bookingTableFeatures = tableFeatures({ columnVisibilityFeature, columnOrderingFeature });
export type BookingTableFeatures = typeof bookingTableFeatures;
export type BookingColumnDef = ColumnDef<BookingTableFeatures, BookingRow>;

// ---- the columns, as the business arranges them ------------------------------------------------------

export function columnLabels(t: TermWords): Record<BookingColumn, string> {
  return { time: "Time", customer: t.Customer, service: "Service", person: t.Practitioner, branch: "Branch", status: "Status", source: "Booked via", channel: "Source", price: "Price" };
}

/** Every bookings column in default order, for the shared column model. The extra ones stay hidden until the business shows them. */
export function bookingColumnSpecs(labels: Record<BookingColumn, string>): GridColumnSpec[] {
  return bookingColumns.map((column) => ({
    id: column,
    label: labels[column],
    // A booking is found by its time and who it is for; the business can rename or hide either but Kalendr needs both.
    system: column === "time" || column === "customer",
    defaultHidden: !defaultBookingColumns.includes(column),
  }));
}

// ---- cells -----------------------------------------------------------------------------------------

/** Where the booking came from: the page that sent them and the campaign, or a dash. */
export function sourceText(row: BookingRow): string {
  return [row.referrerHost, [row.utmSource, row.utmCampaign].filter(Boolean).join(" / ")].filter(Boolean).join(" · ");
}

export function BookingStatus({ row }: { row: BookingRow }) {
  return (
    <span className="flex flex-col items-start gap-1">
      <StatusBadge tone={appointmentStatusTone(row.status)}>{statusLabel(row.status)}</StatusBadge>
      {row.status === "requested" && row.proposedCount > 0 ? <span className="text-xs text-muted-foreground">{row.proposedCount} other {row.proposedCount === 1 ? "time" : "times"} offered</span> : null}
    </span>
  );
}

export function TimeLink({ row }: { row: BookingRow }) {
  return <Link href={appointmentLink(row.id)} data-time-link="" className="whitespace-nowrap font-medium tabular-nums outline-none hover:underline focus-visible:underline focus-visible:decoration-2">{appointmentDateTime(row.startsAt)}</Link>;
}

const muted = <span className="text-muted-foreground" aria-label="None">-</span>;

/** One column's definition. The header is drawn by the table, which gives every column the shared header menu. */
export function bookingColumnDef(column: BookingColumn): BookingColumnDef {
  const text = (read: (row: BookingRow) => string | null | undefined): Pick<BookingColumnDef, "cell"> => ({ cell: ({ row }) => <span className="block max-w-56 truncate">{read(row.original) || muted}</span> });
  switch (column) {
    case "time": return { id: column, accessorFn: (row) => row.startsAt, cell: ({ row }) => <TimeLink row={row.original} /> };
    case "customer": return {
      id: column, accessorFn: (row) => row.customer.name,
      cell: ({ row }) => <span className="flex min-w-0 flex-col"><CustomerLink id={row.original.customer.id} name={row.original.customer.name} phone={row.original.customer.phone} className="truncate font-medium" /><span className="truncate text-xs text-muted-foreground tabular-nums">{row.original.customer.phone}</span></span>,
    };
    case "service": return { id: column, accessorFn: (row) => row.service.name, cell: ({ row }) => <ServiceLink id={row.original.service.id} name={row.original.service.name} className="block max-w-56 truncate" /> };
    case "person": return { id: column, accessorFn: (row) => row.practitioner.name, cell: ({ row }) => <PractitionerLink id={row.original.practitioner.id} name={row.original.practitioner.name} className="block max-w-56 truncate" /> };
    case "branch": return { id: column, accessorFn: (row) => row.location.name, ...text((row) => row.location.name) };
    case "status": return { id: column, accessorFn: (row) => row.status, cell: ({ row }) => <BookingStatus row={row.original} /> };
    case "source": return { id: column, accessorFn: (row) => row.bookingSource, ...text((row) => bookingSourceLabels[row.bookingSource]) };
    case "channel": return { id: column, accessorFn: (row) => sourceText(row), ...text(sourceText) };
    case "price": return { id: column, accessorFn: (row) => row.priceMinor, cell: ({ row }) => <span className="tabular-nums">{row.original.priceMinor === null ? muted : formatMoney(row.original.priceMinor)}</span> };
  }
}
