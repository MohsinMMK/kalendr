"use client";

import { useMemo, useState } from "react";
import { CalendarPlus, ChevronRight, Copy, Ellipsis, FolderHeart, Plus, UserRound } from "lucide-react";
import { useTable, type ColumnDef, type ColumnSizingState, type PaginationState, type SortingState } from "@tanstack/react-table";

import { ActionMenuButton, type ActionMenuEntry } from "@/components/action-bar";
import { PersonAvatar } from "@/components/person-avatar";
import { ExpandingSearch } from "@/components/expanding-search";
import { StatusBadge } from "@/components/status-badge";
import { WorkspaceFrame } from "@/components/workspace-page";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toastManager } from "@/components/ui/toast";
import { DataGrid, dataGridFeatures, type DataGridFeatures } from "@/components/reui/data-grid/data-grid";
import { DataGridColumnHeader } from "@/components/reui/data-grid/data-grid-column-header";
import { GridCustomizeProvider, useGridCustomize } from "@/components/reui/data-grid/data-grid-customize";
import { DataGridPagination } from "@/components/reui/data-grid/data-grid-pagination";
import { DataGridScrollArea } from "@/components/reui/data-grid/data-grid-scroll-area";
import { DataGridTable } from "@/components/reui/data-grid/data-grid-table";
import { Filters } from "@/components/reui/filters/filters";
import { createFilterQuery, createFilterRule } from "@/components/reui/filters/filters-query";
import type { FilterField, FilterQuery } from "@/components/reui/filters/filters-types";
import type { CustomerFieldDefinition } from "@/lib/customer-contracts";
import { compareFieldValues, formatFieldValue, parseMultiValue } from "@/lib/customer-field-values";
import type { Appointment, ContactChannel, Patient } from "@/lib/domain";
import type { GridColumnSpec } from "@/lib/grid-columns";

import { useNarrowerThan } from "./staff-viewport";
import { appointmentDateTime, channelLabel, statusLabel } from "./clinic-format";
import { CustomFieldDialog, DeleteFieldDialog } from "./custom-field-dialog";
import { FieldCell } from "./custom-field-cell";
import { matchesFilterQuery, pickOperators } from "./grid-filter";
import { GridColumnsMenu } from "./grid-columns-menu";
import { MobilePager } from "./grid-pager";
import { patientBookingContext, patientName } from "./patient-directory";
import { appointmentStatusTone } from "./task-ui";
import { useCustomerFields } from "./use-customer-fields";
import { customizeFor, useGridColumns } from "./use-grid-columns";

export const PATIENT_PAGE_SIZE = 10;

export interface PatientRow {
  id: string;
  patient: Patient;
  name: string;
  phone: string;
  email: string;
  channel: ContactChannel;
  nextAt: string;
  nextStatus: Appointment["status"] | null;
  reminders: "allowed" | "email_only";
  /** The business's own fields' answers for this customer. They travel with the row so that a saved answer updates the cell in place instead of rebuilding the columns. */
  answers?: Record<string, string>;
}

/** One header component for every column, defined once so a re-render never remounts an open column menu. The title travels in `meta`. */
const HeaderCell: ColumnDef<DataGridFeatures, PatientRow>["header"] = ({ column }) => <DataGridColumnHeader column={column} />;

const channelOptions = (["sms", "email", "whatsapp", "phone"] as const).map((value) => ({ value, label: channelLabel(value) }));

/** One grid row per patient, with the next booking worked out once. */
export function patientRows(patients: Patient[], appointments: Appointment[], clockIso: string): PatientRow[] {
  return patients.map((patient) => {
    const context = patientBookingContext(patient.id, appointments, clockIso);
    const next = context?.kind === "next" ? context.appointment : null;
    return {
      id: patient.id,
      patient,
      name: patientName(patient),
      phone: patient.phone,
      email: patient.email,
      channel: patient.preferredChannel,
      nextAt: next?.startsAt ?? "",
      nextStatus: next?.status ?? null,
      reminders: patient.messagingConsentAt ? "allowed" : "email_only",
    };
  });
}

/** A custom field's column id, so it can never collide with a built-in column. */
const columnOfField = (fieldId: string) => `cf-${fieldId}`;
const fieldOfColumn = (columnId: string) => (columnId.startsWith("cf-") ? columnId.slice(3) : null);

/** The filter each built-in column opens from its header menu. */
const filterOfColumn: Record<string, string> = { name: "name", phone: "phone", email: "email", channel: "channel", next: "booking", status: "booking" };

/** The "+" at the end of the header: adds one of the business's own fields. */
function AddFieldHeader() {
  const customize = useGridCustomize();
  return (
    <Button size="icon-sm" variant="ghost" aria-label="Add a field" className="-ms-1 size-6 rounded-lg" onClick={() => customize?.onAddField?.()}>
      <Plus aria-hidden="true" />
    </Button>
  );
}

function filterFieldFor(definition: CustomerFieldDefinition): FilterField {
  const id = columnOfField(definition.id);
  const base = { id, label: definition.label, searchable: false };
  switch (definition.kind) {
    case "choice":
    case "multichoice":
      return { ...base, type: "select", defaultOperator: "is_any_of", options: definition.choices.map((choice) => ({ value: choice, label: choice })), operators: pickOperators };
    case "boolean":
      return { ...base, type: "select", defaultOperator: "is_any_of", options: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }], operators: pickOperators };
    case "number":
      return { ...base, type: "number" };
    default:
      return { ...base, type: "text" };
  }
}

export function PatientsGrid({ rows, terms, query, onQueryChange, pagination, onPaginationChange, onOpen, onBook, recordsHref, empty, tabs, replace, live = false }: {
  rows: PatientRow[];
  terms: { customer: string; customers: string; Customer: string };
  query: string;
  onQueryChange: (query: string) => void;
  pagination: PaginationState;
  onPaginationChange: (next: PaginationState) => void;
  onOpen: (id: string) => void;
  onBook: (id: string) => void;
  /** Omit when records are off or the signed-in person can't see them. */
  recordsHref?: (id: string) => string;
  empty: React.ReactNode;
  /** Tabs on the left of the frame toolbar; the search moves to the right. */
  tabs?: React.ReactNode;
  /** Shown in the frame instead of the list, for another tab. The frame and its tabs stay put. */
  replace?: React.ReactNode;
  /** True when the list comes from the database, which is where the business's own fields live. */
  live?: boolean;
}) {
  const mobile = useNarrowerThan("sm");
  // Below a wide laptop the grid would scroll sideways, so preferred contact and status fold into the booking cell.
  const compact = useNarrowerThan("xl");
  const [filter, setFilter] = useState<FilterQuery>(() => createFilterQuery([]));
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CustomerFieldDefinition | null>(null);
  const [deleting, setDeleting] = useState<CustomerFieldDefinition | null>(null);
  const custom = useCustomerFields(live);
  const answerOf = (row: PatientRow, fieldId: string) => row.answers?.[fieldId] ?? "";
  const answered = useMemo(() => rows.map((row) => ({ ...row, answers: custom.values[row.id] })), [custom.values, rows]);

  const specs = useMemo<GridColumnSpec[]>(() => [
    { id: "name", label: terms.Customer, system: true },
    { id: "phone", label: "Phone", system: true },
    { id: "email", label: "Email", system: true, defaultHidden: true },
    { id: "channel", label: "Preferred contact" },
    { id: "next", label: "Next booking" },
    { id: "status", label: "Status" },
    ...custom.definitions.map((definition) => ({ id: columnOfField(definition.id), label: definition.label, custom: true })),
  ], [custom.definitions, terms.Customer]);
  const columns = useGridColumns("patients", specs, custom.ready);
  const definitionOf = (columnId: string) => custom.definitions.find((definition) => definition.id === fieldOfColumn(columnId));

  const readField = (row: PatientRow, field: string): unknown => {
    if (field === "name") return row.name;
    if (field === "phone") return row.phone;
    if (field === "email") return row.email;
    if (field === "channel") return row.channel;
    if (field === "booking") return row.nextStatus ?? "none";
    if (field === "reminders") return row.reminders;
    const definition = definitionOf(field);
    if (!definition) return "";
    const answer = answerOf(row, definition.id);
    return definition.kind === "multichoice" ? parseMultiValue(answer) : answer;
  };
  const filtered = useMemo(
    () => answered.filter((row) => matchesFilterQuery(row, filter, readField)),
    // readField reads the latest answers and fields through these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [answered, filter, custom.definitions],
  );

  const filterFields = useMemo<FilterField[]>(() => [
    { id: "name", label: columns.all.find((column) => column.id === "name")?.title ?? terms.Customer, type: "text" },
    { id: "phone", label: columns.all.find((column) => column.id === "phone")?.title ?? "Phone", type: "text" },
    { id: "email", label: columns.all.find((column) => column.id === "email")?.title ?? "Email", type: "text" },
    { id: "channel", label: "Preferred contact", type: "select", defaultOperator: "is_any_of", options: channelOptions, searchable: false, operators: pickOperators },
    {
      id: "booking",
      label: "Next booking",
      type: "select",
      defaultOperator: "is_any_of",
      options: [
        { value: "booked", label: statusLabel("booked") },
        { value: "requested", label: statusLabel("requested") },
        { value: "none", label: "No booking" },
      ],
      searchable: false,
      operators: pickOperators,
    },
    {
      id: "reminders",
      label: "Reminders",
      type: "select",
      defaultOperator: "is_any_of",
      options: [{ value: "allowed", label: "Text or WhatsApp allowed" }, { value: "email_only", label: "Email only" }],
      searchable: false,
      operators: pickOperators,
    },
    ...custom.definitions.map(filterFieldFor),
  ], [columns.all, custom.definitions, terms.Customer]);

  const visible = columns.visible;
  const shown = useMemo(() => visible.filter((column) => !(compact && (column.id === "channel" || column.id === "status"))), [compact, visible]);

  const tableColumns = useMemo<ColumnDef<DataGridFeatures, PatientRow>[]>(() => {
    const defs: ColumnDef<DataGridFeatures, PatientRow>[] = shown.map((entry): ColumnDef<DataGridFeatures, PatientRow> => {
      switch (entry.id) {
        case "name": return {
          id: "name",
          accessorFn: (row) => row.name,
          header: HeaderCell,
          cell: ({ row }) => (
            <span className="flex items-center gap-3">
              <PersonAvatar name={row.original.name} />
              <span className="min-w-0">
                <button
                  type="button"
                  className="block cursor-pointer truncate text-start text-sm font-medium outline-2 outline-transparent hover:underline focus-visible:outline-ring"
                  onClick={(event) => { event.stopPropagation(); onOpen(row.original.id); }}
                >
                  {row.original.name}
                </button>
                {row.original.patient.blockedAt ? <span className="inline-flex items-center rounded-sm bg-warning/8 px-1.5 text-warning-foreground text-xs">Blocked online</span> : null}
              </span>
            </span>
          ),
          size: 230,
          meta: { fillWidth: true, headerTitle: entry.title },
        };
        case "phone": return { id: "phone", accessorFn: (row) => row.phone, header: HeaderCell, meta: { headerTitle: entry.title }, cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{row.original.phone}</span>, size: 150 };
        case "email": return { id: "email", accessorFn: (row) => row.email, header: HeaderCell, meta: { headerTitle: entry.title }, cell: ({ row }) => <span className="block truncate">{row.original.email || <span className="text-muted-foreground">None</span>}</span>, size: 220 };
        case "channel": return { id: "channel", accessorFn: (row) => channelLabel(row.channel), header: HeaderCell, meta: { headerTitle: entry.title }, size: 150 };
        case "next": return {
          id: "next",
          accessorFn: (row) => row.nextAt,
          header: HeaderCell,
          meta: { headerTitle: entry.title },
          cell: ({ row }) => row.original.nextAt
            ? (
              <span className="flex flex-col items-start gap-1">
                <span className="whitespace-nowrap tabular-nums">{appointmentDateTime(row.original.nextAt)}</span>
                {compact && row.original.nextStatus ? <StatusBadge tone={appointmentStatusTone(row.original.nextStatus)}>{statusLabel(row.original.nextStatus)}</StatusBadge> : null}
              </span>
            )
            : <span className="text-muted-foreground">None</span>,
          size: 200,
        };
        case "status": return {
          id: "status",
          accessorFn: (row) => row.nextStatus ?? "",
          header: HeaderCell,
          meta: { headerTitle: entry.title },
          cell: ({ row }) => row.original.nextStatus
            ? <StatusBadge tone={appointmentStatusTone(row.original.nextStatus)}>{statusLabel(row.original.nextStatus)}</StatusBadge>
            : <span className="text-xs text-muted-foreground">No booking</span>,
          size: 150,
        };
        default: {
          const definition = definitionOf(entry.id);
          if (!definition) return { id: entry.id, header: HeaderCell, meta: { headerTitle: entry.title }, size: 150 };
          return {
            id: entry.id,
            accessorFn: (row) => answerOf(row, definition.id),
            // Empty answers go last whichever way the column is sorted.
            sortFn: (a, b, columnId) => compareFieldValues(definition, a.getValue<string>(columnId), b.getValue<string>(columnId)),
            header: HeaderCell,
            meta: { headerTitle: definition.label },
            cell: ({ row }) => (
              <FieldCell
                definition={definition}
                value={answerOf(row.original, definition.id)}
                canEdit={custom.canEditValues}
                customerName={row.original.name}
                onSave={(next) => custom.saveValue(row.original.id, definition.id, next)}
              />
            ),
            size: 170,
          };
        }
      }
    }).map((def) => {
      const width = shown.find((entry) => entry.id === def.id)?.width;
      return width ? { ...def, size: width } : def;
    });
    if (custom.canDefine) {
      defs.push({
        id: "add-field",
        header: AddFieldHeader,
        enableSorting: false,
        enableResizing: false,
        enableHiding: false,
        cell: () => null,
        size: 48,
      });
    }
    defs.push({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      enableResizing: false,
      cell: ({ row }) => {
        const entries: ActionMenuEntry[] = [
          { id: "open", label: "Open profile", icon: <UserRound />, onSelect: () => onOpen(row.original.id) },
          { id: "book", label: "Book", icon: <CalendarPlus />, onSelect: () => onBook(row.original.id) },
          ...(recordsHref ? [{ id: "records", label: "Records", icon: <FolderHeart />, href: recordsHref(row.original.id) }] : []),
          { kind: "separator", id: "sep" },
          {
            id: "copy",
            label: "Copy phone",
            icon: <Copy />,
            onSelect: () => {
              void navigator.clipboard?.writeText(row.original.phone);
              toastManager.add({ title: "Phone copied", type: "success" });
            },
          },
        ];
        return (
          // Menu clicks bubble through the React tree, so they would also open the row.
          <div className="flex justify-end" onClick={(event) => event.stopPropagation()}>
            <ActionMenuButton label={`Actions for ${row.original.name}`} iconOnly variant="ghost" items={entries} icon={<Ellipsis />} />
          </div>
        );
      },
      size: 56,
    });
    return defs;
    // answerOf and definitionOf read the latest answers and fields through these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact, custom.canDefine, custom.canEditValues, custom.definitions, custom.saveValue, onBook, onOpen, recordsHref, shown]);

  const columnSizing = useMemo<ColumnSizingState>(() => Object.fromEntries(shown.flatMap((entry) => (entry.width ? [[entry.id, entry.width] as const] : []))), [shown]);

  // A sort on a column the business hid would point at nothing, so it is left out until the column shows again.
  const shownSorting = useMemo(() => {
    const ids = new Set(tableColumns.map((column) => column.id ?? (column as { accessorKey?: string }).accessorKey));
    return sorting.filter((entry) => ids.has(entry.id));
  }, [sorting, tableColumns]);

  const table = useTable({
    features: dataGridFeatures,
    columns: tableColumns,
    data: filtered,
    pageCount: Math.max(1, Math.ceil(filtered.length / pagination.pageSize)),
    getRowId: (row: PatientRow) => row.id,
    state: { pagination, sorting: shownSorting, columnSizing },
    onPaginationChange: (updater) => onPaginationChange(typeof updater === "function" ? updater(pagination) : updater),
    onSortingChange: setSorting,
    // A width is remembered for the whole business when the drag ends.
    onColumnSizingChange: (updater) => {
      const next = typeof updater === "function" ? updater(columnSizing) : updater;
      for (const [id, width] of Object.entries(next)) if (columnSizing[id] !== width && shown.some((entry) => entry.id === id)) columns.resize(id, width);
    },
  });

  const customize = customizeFor(columns, {
    onAddField: () => setAdding(true),
    isSystem: (id) => Boolean(specs.find((spec) => spec.id === id)?.system),
    canFilter: (id) => id in filterOfColumn || fieldOfColumn(id) !== null,
    filter: (id) => {
      const target = filterOfColumn[id] ?? id;
      const field = filterFields.find((item) => item.id === target);
      setFilter((current) => ({ ...current, rules: [...current.rules, createFilterRule({ id: crypto.randomUUID(), path: [target], operator: field?.defaultOperator ?? "" })] }));
    },
    rename: (id, name) => {
      const definition = definitionOf(id);
      if (definition) void custom.renameField(definition, name);
      else columns.rename(id, name);
    },
    field: {
      isField: (id) => definitionOf(id) !== undefined,
      canManage: custom.canDefine,
      edit: (id) => setEditing(definitionOf(id) ?? null),
      remove: (id) => setDeleting(definitionOf(id) ?? null),
    },
  });

  const pageCount = Math.max(1, Math.ceil(filtered.length / pagination.pageSize));
  const currentPage = Math.min(pagination.pageIndex + 1, pageCount);
  const mobileRows = [...filtered]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice((currentPage - 1) * pagination.pageSize, currentPage * pagination.pageSize);
  // The phone cards follow the same arrangement: what the business hid stays hidden, and its own fields show under the name.
  const showsOnPhone = (id: string) => columns.visible.some((column) => column.id === id);
  const phoneFields = columns.visible.flatMap((column) => {
    const definition = definitionOf(column.id);
    return definition ? [definition] : [];
  }).slice(0, 2);
  const nextLabel = columns.all.find((column) => column.id === "next")?.title ?? "Next booking";

  const search = (
        <ExpandingSearch
          label={`Search ${terms.customers}`}
          value={query}
          onValueChange={onQueryChange}
          placeholder="Search by name, phone, or email"
        />
  );

  return (
    <GridCustomizeProvider value={customize}>
    <DataGrid
      table={table}
      recordCount={filtered.length}
      onRowClick={(row) => onOpen(row.id)}
      emptyMessage={`No ${terms.customers} match these filters`}
      tableLayout={{ dense: true, headerBackground: true, columnsResizable: columns.canEdit, columnsResizeMode: "onEnd" }}
    >
    <WorkspaceFrame
      flush
      start={tabs}
      end={replace ? search : <>
        {search}
        <Filters
          fields={filterFields}
          query={filter}
          onQueryChange={(next) => { setFilter(next); onPaginationChange({ ...pagination, pageIndex: 0 }); }}
          showClear
          size="sm"
        />
        {mobile ? null : <GridColumnsMenu columns={columns} />}
      </>}
      footer={replace || filtered.length === 0 ? null : (mobile ? (
            <MobilePager label={`${terms.Customer} pages`} page={currentPage} pageCount={pageCount} onPage={(page) => onPaginationChange({ ...pagination, pageIndex: page - 1 })} />
          ) : (
            <DataGridPagination sizes={[10, 25, 50]} className="w-full flex-row py-0 **:order-none! *:py-0! *:last:flex-row!" />
          ))}
    >
        {replace ?? (filtered.length === 0 ? empty : mobile ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{columns.all.find((column) => column.id === "name")?.title ?? terms.Customer}</TableHead>
                <TableHead><span className="sr-only">Open</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mobileRows.map((item) => (
                <TableRow key={item.id} className="cursor-pointer" onClick={() => onOpen(item.id)}>
                  <TableHead scope="row" className="h-auto whitespace-normal py-2 font-normal text-foreground">
                    <span className="flex items-center gap-3">
                      <PersonAvatar name={item.name} />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{item.name}</span>
                        {showsOnPhone("phone") ? <span className="block text-xs text-muted-foreground tabular-nums whitespace-nowrap">{item.phone}</span> : null}
                        {showsOnPhone("email") && item.email ? <span className="block truncate text-xs text-muted-foreground">{item.email}</span> : null}
                        {showsOnPhone("next") ? <span className="block text-xs text-muted-foreground tabular-nums">{item.nextAt ? `${nextLabel}: ${appointmentDateTime(item.nextAt)}` : "No upcoming booking"}</span> : null}
                        {phoneFields.map((definition) => {
                          const answer = answerOf(item, definition.id);
                          return answer ? <span key={definition.id} className="block truncate text-xs text-muted-foreground">{definition.label}: {formatFieldValue(definition, answer)}</span> : null;
                        })}
                      </span>
                    </span>
                  </TableHead>
                  <TableCell className="w-10 text-end">
                    <Button size="icon-sm" variant="ghost" aria-label={`Open ${item.name}`} onClick={(event) => { event.stopPropagation(); onOpen(item.id); }}>
                      <ChevronRight aria-hidden="true" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <DataGridScrollArea>
            <DataGridTable />
          </DataGridScrollArea>
        ))}
    </WorkspaceFrame>
    </DataGrid>
    <CustomFieldDialog open={adding || editing !== null} onOpenChange={(open) => { if (!open) { setAdding(false); setEditing(null); } }} definition={editing ?? undefined} />
    <DeleteFieldDialog definition={deleting} onOpenChange={(open) => { if (!open) setDeleting(null); }} />
    </GridCustomizeProvider>
  );
}
