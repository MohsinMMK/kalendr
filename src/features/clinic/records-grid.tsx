"use client";

import { useMemo, useState } from "react";
import { useTable, type ColumnDef, type ColumnSizingState, type PaginationState, type SortingState } from "@tanstack/react-table";

import { PersonAvatar } from "@/components/person-avatar";
import { ExpandingSearch } from "@/components/expanding-search";
import { StatusBadge } from "@/components/status-badge";
import { WorkspaceFrame } from "@/components/workspace-page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DataGrid, dataGridFeatures, type DataGridFeatures } from "@/components/reui/data-grid/data-grid";
import { DataGridColumnHeader } from "@/components/reui/data-grid/data-grid-column-header";
import { GridCustomizeProvider } from "@/components/reui/data-grid/data-grid-customize";
import { DataGridPagination } from "@/components/reui/data-grid/data-grid-pagination";
import { DataGridScrollArea } from "@/components/reui/data-grid/data-grid-scroll-area";
import { DataGridTable } from "@/components/reui/data-grid/data-grid-table";
import { Filters } from "@/components/reui/filters/filters";
import { createFilterQuery, createFilterRule } from "@/components/reui/filters/filters-query";
import type { FilterField, FilterQuery } from "@/components/reui/filters/filters-types";
import type { GridColumnSpec } from "@/lib/grid-columns";
import type { VisitRecordKind, VisitRecordSummary } from "@/lib/visit-records";

import { useNarrowerThan } from "./staff-viewport";
import { GridColumnsMenu } from "./grid-columns-menu";
import { matchesFilterQuery, pickOperators } from "./grid-filter";
import { MobilePager } from "./grid-pager";
import { customizeFor, useGridColumns } from "./use-grid-columns";

export const RECORD_PAGE_SIZE = 10;

const day = (iso: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(iso));

function readField(record: VisitRecordSummary, field: string): unknown {
  if (field === "kind") return record.kind;
  if (field === "status") return record.status;
  if (field === "practitioner") return record.practitionerName ?? "";
  return "";
}

/** The filter each column opens from its header menu. Customer and date have none here. */
const filterOfColumn: Record<string, string> = { document: "kind", practitioner: "practitioner", status: "status" };

/** One header component for every column, defined once so a re-render never remounts an open column menu. The title travels in `meta`. */
const HeaderCell: ColumnDef<DataGridFeatures, VisitRecordSummary>["header"] = ({ column }) => <DataGridColumnHeader column={column} />;

export function RecordsGrid({ records, kindLabels, terms, query, onQueryChange, extra, top, onOpen, empty }: {
  /** Already narrowed by search and by a single-patient link. */
  records: VisitRecordSummary[];
  kindLabels: Record<VisitRecordKind, string>;
  terms: { customer: string; Customer: string; Practitioner: string };
  query: string;
  onQueryChange: (query: string) => void;
  /** Shown beside the filters, like the single-patient chip. */
  extra?: React.ReactNode;
  /** Above the table, inside the frame: requests waiting on staff. */
  top?: React.ReactNode;
  onOpen: (id: string) => void;
  empty: React.ReactNode;
}) {
  const mobile = useNarrowerThan("sm");
  const [filter, setFilter] = useState<FilterQuery>(() => createFilterQuery([]));
  const [sorting, setSorting] = useState<SortingState>([{ id: "date", desc: true }]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: RECORD_PAGE_SIZE });
  const filtered = useMemo(() => records.filter((record) => matchesFilterQuery(record, filter, readField)), [filter, records]);

  const specs = useMemo<GridColumnSpec[]>(() => [
    { id: "patient", label: terms.Customer, system: true },
    { id: "document", label: "Document", system: true },
    { id: "practitioner", label: terms.Practitioner },
    { id: "status", label: "Status" },
    { id: "date", label: "Date" },
  ], [terms.Customer, terms.Practitioner]);
  const columns = useGridColumns("records", specs);

  const fields = useMemo<FilterField[]>(() => {
    const practitioners = [...new Set(records.map((record) => record.practitionerName).filter((name): name is string => Boolean(name)))].sort();
    return [
      { id: "kind", label: "Type", type: "select", defaultOperator: "is_any_of", options: (Object.keys(kindLabels) as VisitRecordKind[]).map((value) => ({ value, label: kindLabels[value] })), searchable: false, operators: pickOperators },
      { id: "status", label: "Status", type: "select", defaultOperator: "is_any_of", options: [{ value: "draft", label: "Draft" }, { value: "shared", label: "Shared" }], searchable: false, operators: pickOperators },
      ...(practitioners.length ? [{ id: "practitioner", label: terms.Practitioner, type: "select" as const, defaultOperator: "is_any_of", options: practitioners.map((name) => ({ value: name, label: name })), operators: pickOperators }] : []),
    ];
  }, [kindLabels, records, terms.Practitioner]);

  const shown = columns.visible;

  const tableColumns = useMemo<ColumnDef<DataGridFeatures, VisitRecordSummary>[]>(() => shown.map((entry): ColumnDef<DataGridFeatures, VisitRecordSummary> => {
    const base = { header: HeaderCell, meta: { headerTitle: entry.title }, size: entry.width };
    switch (entry.id) {
      case "patient": return {
        ...base,
        id: "patient",
        accessorFn: (record) => record.patientName,
        cell: ({ row }) => (
          <span className="flex items-center gap-3">
            <PersonAvatar name={row.original.patientName} />
            <span className="truncate font-medium">{row.original.patientName}</span>
          </span>
        ),
        size: entry.width ?? 220,
      };
      case "document": return {
        ...base,
        id: "document",
        accessorFn: (record) => record.title,
        cell: ({ row }) => (
          <span className="block min-w-0">
            <button
              type="button"
              className="block max-w-full cursor-pointer truncate text-start font-medium outline-2 outline-transparent hover:underline focus-visible:outline-ring"
              onClick={(event) => { event.stopPropagation(); onOpen(row.original.id); }}
            >
              {row.original.title}
            </button>
            <span className="block truncate text-xs text-muted-foreground">
              {kindLabels[row.original.kind]}{row.original.fileCount ? ` · ${row.original.fileCount} file${row.original.fileCount === 1 ? "" : "s"}` : ""}
            </span>
          </span>
        ),
        size: entry.width ?? 300,
        meta: { headerTitle: entry.title, fillWidth: true },
      };
      case "practitioner": return { ...base, id: "practitioner", accessorFn: (record) => record.practitionerName ?? "", cell: ({ row }) => row.original.practitionerName ?? "—", size: entry.width ?? 170 };
      case "status": return {
        ...base,
        id: "status",
        accessorFn: (record) => record.status,
        cell: ({ row }) => <StatusBadge tone={row.original.status === "shared" ? "success" : "neutral"}>{row.original.status === "shared" ? "Shared" : "Draft"}</StatusBadge>,
        size: entry.width ?? 120,
      };
      default: return {
        ...base,
        id: "date",
        accessorFn: (record) => record.sharedAt ?? record.createdAt,
        cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{day(row.original.sharedAt ?? row.original.createdAt)}</span>,
        size: entry.width ?? 130,
      };
    }
  }), [kindLabels, onOpen, shown]);

  const columnSizing = useMemo<ColumnSizingState>(() => Object.fromEntries(shown.flatMap((entry) => (entry.width ? [[entry.id, entry.width] as const] : []))), [shown]);

  const table = useTable({
    features: dataGridFeatures,
    columns: tableColumns,
    data: filtered,
    pageCount: Math.max(1, Math.ceil(filtered.length / pagination.pageSize)),
    getRowId: (record: VisitRecordSummary) => record.id,
    state: { pagination, sorting, columnSizing },
    onPaginationChange: setPagination,
    onSortingChange: setSorting,
    // A width is remembered for the whole business when the drag ends.
    onColumnSizingChange: (updater) => {
      const next = typeof updater === "function" ? updater(columnSizing) : updater;
      for (const [id, width] of Object.entries(next)) if (columnSizing[id] !== width && shown.some((entry) => entry.id === id)) columns.resize(id, width);
    },
  });

  const customize = customizeFor(columns, {
    isSystem: (id) => Boolean(specs.find((spec) => spec.id === id)?.system),
    canFilter: (id) => id in filterOfColumn && fields.some((field) => field.id === filterOfColumn[id]),
    filter: (id) => {
      const target = filterOfColumn[id];
      const field = fields.find((item) => item.id === target);
      if (!target) return;
      setFilter((current) => ({ ...current, rules: [...current.rules, createFilterRule({ id: crypto.randomUUID(), path: [target], operator: field?.defaultOperator ?? "" })] }));
    },
  });

  const pageCount = Math.max(1, Math.ceil(filtered.length / pagination.pageSize));
  const currentPage = Math.min(pagination.pageIndex + 1, pageCount);
  const mobileRows = filtered.slice((currentPage - 1) * pagination.pageSize, currentPage * pagination.pageSize);
  const title = (id: string) => columns.all.find((column) => column.id === id)?.title ?? "";
  const showsOnPhone = (id: string) => columns.visible.some((column) => column.id === id);

  return (
    <GridCustomizeProvider value={customize}>
    <DataGrid
      table={table}
      recordCount={filtered.length}
      onRowClick={(record) => onOpen(record.id)}
      emptyMessage="No records match these filters"
      tableLayout={{ dense: true, headerBackground: true, columnsResizable: columns.canEdit, columnsResizeMode: "onEnd" }}
    >
      <WorkspaceFrame
        flush
        end={<>
          <ExpandingSearch
            label="Search records"
            placeholder={`Search ${terms.customer} or title`}
            value={query}
            onValueChange={(next) => { onQueryChange(next); setPagination((current) => ({ ...current, pageIndex: 0 })); }}
          />
          <Filters
            fields={fields}
            query={filter}
            onQueryChange={(next) => { setFilter(next); setPagination((current) => ({ ...current, pageIndex: 0 })); }}
            showClear
            size="sm"
          />
          {mobile ? null : <GridColumnsMenu columns={columns} />}
          {extra}
        </>}
        footer={filtered.length === 0 ? null : <>
            {mobile ? (
              <MobilePager label="Record pages" page={currentPage} pageCount={pageCount} onPage={(page) => setPagination((current) => ({ ...current, pageIndex: page - 1 }))} />
            ) : (
              <DataGridPagination sizes={[10, 25, 50]} className="w-full flex-row py-0 **:order-none! *:py-0! *:last:flex-row!" />
            )}
        </>}
      >
        {top}
          {filtered.length === 0 ? empty : mobile ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{title("patient")}</TableHead>
                  <TableHead>{title("document")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mobileRows.map((record) => (
                  <TableRow key={record.id} className="cursor-pointer" onClick={() => onOpen(record.id)}>
                    <TableCell className="whitespace-normal">
                      <div className="flex min-w-0 items-center gap-3">
                        <PersonAvatar name={record.patientName} />
                        <span className="font-medium">{record.patientName}</span>
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <button type="button" className="cursor-pointer text-start font-medium underline-offset-2 hover:underline" onClick={(event) => { event.stopPropagation(); onOpen(record.id); }}>{record.title}</button>
                      <p className="text-xs text-muted-foreground">
                        {kindLabels[record.kind]}{record.fileCount ? ` · ${record.fileCount} file${record.fileCount === 1 ? "" : "s"}` : ""}
                        {showsOnPhone("status") ? ` · ${record.status === "shared" ? "Shared" : "Draft"}` : ""}
                      </p>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <DataGridScrollArea>
              <DataGridTable />
            </DataGridScrollArea>
          )}
      </WorkspaceFrame>
    </DataGrid>
    </GridCustomizeProvider>
  );
}
