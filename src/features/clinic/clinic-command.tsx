"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowDownIcon, ArrowUpIcon, CornerDownLeftIcon } from "lucide-react";

import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { demoAppointments } from "@/lib/demo-data";
import type { SearchHit, SearchKind } from "@/lib/search";

import { appointmentTime } from "./clinic-format";
import { matchesQuery, parseDateQuery } from "./command-search";
import { appointmentPatientName, dayVisits } from "./clinic-today";
import { patientName } from "./patient-directory";
import { useNewVisit } from "./new-visit-sheet";
import { clinicDateKey, usePreviewAppointments } from "./preview-appointments";
import { patientSearchMinLength } from "./queries/patient-search";
import { useStaffSearch } from "./queries/staff-search";
import { dayLabel } from "./schedule-model";
import { useShortcutHelp } from "./shortcuts";
import { useEntryAvailable, useNavLabels, useNavSections } from "./sidebar-nav";
import { useStaffAccess } from "./staff-access";
import { useOptionalStaffSnapshot } from "./staff-snapshot-provider";

interface CommandEntry {
  value: string;
  label: string;
  shortcut?: string;
  run: () => void;
}

interface CommandEntryGroup {
  value: string;
  items: CommandEntry[];
}

export function ClinicCommand({ open, onOpenChange, clinicSlug, onOpenSettings, onOpenHelp }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clinicSlug: string;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const staff = useOptionalStaffSnapshot();
  const t = useTerms();
  const { openNewVisit } = useNewVisit();
  const sections = useNavSections();
  const settingsAvailable = useEntryAvailable()("settings");
  const canBook = useStaffAccess().can("appointments.book");
  const labels = useNavLabels();
  // Renaming Settings renames this action too; otherwise it keeps the business word ("Salon settings").
  const settingsLabel = labels.settings === "Settings" ? `${t.Business} settings` : labels.settings;
  const openShortcuts = useShortcutHelp();
  const { appointments, patients, operations, database } = usePreviewAppointments();
  const [origin, setOrigin] = useState("");
  const [query, setQuery] = useState("");
  // Everything findable comes from the server, so every record is reachable and only what this role may open is returned.
  const search = useStaffSearch(query, open && database);

  useEffect(() => {
    // Each time the palette opens it starts empty.
    if (!open) queueMicrotask(() => setQuery(""));
  }, [open]);

  useEffect(() => {
    queueMicrotask(() => setOrigin(window.location.origin));
  }, []);

  const todayKey = database ? clinicDateKey(operations.clockIso) : clinicDateKey(demoAppointments[0].startsAt);
  const text = query.trim();

  const groups = useMemo<CommandEntryGroup[]>(() => {
    function openPatient(id: string) {
      const href = `/patients?patient=${encodeURIComponent(id)}`;
      if (pathname === "/patients") {
        // The patients workspace follows the URL through popstate, without a server round trip.
        window.history.pushState({}, "", href);
        window.dispatchEvent(new PopStateEvent("popstate"));
      } else {
        router.push(href);
      }
    }
    const bookingPath = `/book/${clinicSlug}`;
    // The pages in the business's own names and order. A hidden entry stays out, as it does in the sidebar, and so does
    // anything this person has no access to; Settings, Help and the business's page are in Actions.
    const navigate: CommandEntry[] = sections
      .flatMap((section) => section.entries)
      .filter((entry) => entry.href && entry.id !== "your-page")
      .map((entry) => ({ value: `go-${entry.id}`, label: entry.label, run: () => router.push(entry.href ?? "/dashboard") }));
    const actions: CommandEntry[] = [
      ...(canBook ? [{ value: "new-appointment", label: `New ${t.appointment}`, shortcut: "N", run: () => openNewVisit() }] : []),
      ...(settingsAvailable ? [{ value: "open-settings", label: settingsLabel, run: onOpenSettings }] : []),
      { value: "print-day", label: "Print today's day sheet", run: () => window.open(`/print/day?date=${todayKey}`, "_blank", "noopener") },
      ...(openShortcuts ? [{ value: "open-shortcuts", label: "Keyboard shortcuts", shortcut: "?", run: openShortcuts }] : []),
      { value: "open-help", label: labels.help, run: onOpenHelp },
      { value: "open-page", label: `Open ${labels["your-page"].toLowerCase()}`, run: () => router.push(`/b/${clinicSlug}`) },
      { value: "open-booking", label: `Open ${t.customer} booking page`, run: () => router.push(bookingPath) },
      {
        value: "copy-booking",
        label: `Copy ${t.customer} booking link`,
        run: () => {
          void navigator.clipboard.writeText(`${origin}${bookingPath}`).then(
            () => toastManager.add({ title: "Booking link copied", type: "success" }),
            () => toastManager.add({ title: "Could not copy the booking link", type: "error" }),
          );
        },
      },
    ];
    const dateKey = parseDateQuery(text, todayKey);
    const jump: CommandEntry[] = dateKey ? [{ value: `date-${dateKey}`, label: `Open the schedule on ${dayLabel(dateKey, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`, run: () => router.push(`/schedule?date=${dateKey}`) }] : [];

    // Until a business's snapshot has loaded the hook still holds demo records, which must not be offered.
    const hasRecords = !staff || Boolean(staff.snapshot);
    const found: { id: string; name: string; detail: string }[] = database
      ? search.hits.filter((hit) => hit.kind === "customer").map((hit) => ({ id: hit.id, name: hit.title, detail: hit.subtitle }))
      : hasRecords && text.length >= patientSearchMinLength ? patients.filter((patient) => matchesQuery(`${patient.firstName} ${patient.lastName} ${patient.phone} ${patient.email}`, text)).slice(0, 8).map((patient) => ({ id: patient.id, name: patientName(patient), detail: patient.phone })) : [];
    const directory: CommandEntry[] = found.map((patient) => ({ value: `patient-${patient.id}`, label: `${patient.name} · ${patient.detail}`, run: () => openPatient(patient.id) }));
    const booking: CommandEntry[] = found.slice(0, 3).map((patient) => ({ value: `book-${patient.id}`, label: `Book ${patient.name}`, run: () => router.push(`/appointments/new?patient=${encodeURIComponent(patient.id)}`) }));
    const records = (kind: SearchKind, open: (hit: SearchHit) => void, label: (hit: SearchHit) => string): CommandEntry[] =>
      search.hits.filter((hit) => hit.kind === kind).map((hit) => ({ value: `${kind}-${hit.id}`, label: label(hit), run: () => open(hit) }));
    const withDetail = (hit: SearchHit) => (hit.subtitle ? `${hit.title} · ${hit.subtitle}` : hit.title);
    const visitHits = database ? records("appointment", (hit) => router.push(`/schedule?date=${hit.day ?? todayKey}&open=${encodeURIComponent(hit.id)}`), (hit) => `${hit.title} · ${hit.subtitle}${hit.at ? ` · ${new Date(hit.at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}` : ""}`) : [];
    const serviceHits = database ? records("service", (hit) => router.push(`/appointments/new?service=${encodeURIComponent(hit.id)}`), withDetail) : [];
    const personHits = database ? records("person", () => router.push("/doctors"), withDetail) : [];
    const invoiceHits = database ? records("invoice", (hit) => router.push(`/patients?patient=${encodeURIComponent(hit.customerId ?? "")}`), withDetail) : [];
    const routingHits = database ? records("routing_form", (hit) => router.push(`/routing-forms?form=${encodeURIComponent(hit.id)}`), withDetail) : [];
    const campaignHits = database ? records("campaign", (hit) => router.push(`/campaigns?campaign=${encodeURIComponent(hit.id)}`), withDetail) : [];
    // With nothing typed, the day's visits are the quickest way to a booking someone is asking about.
    const visits: CommandEntry[] = hasRecords && !text ? dayVisits(appointments, todayKey).slice(0, 8).map((appointment) => ({
      value: `visit-${appointment.id}`,
      label: `${appointmentPatientName(appointment, patients, t)} at ${appointmentTime(appointment.startsAt)}`,
      run: () => router.push(`/schedule?date=${todayKey}&open=${encodeURIComponent(appointment.id)}`),
    })) : [];
    const keep = (entries: CommandEntry[]) => entries.filter((entry) => matchesQuery(entry.label, text));
    return [
      { value: t.Customers, items: directory },
      { value: t.Visits, items: visitHits },
      { value: t.Services, items: serviceHits },
      { value: t.Practitioners, items: personHits },
      { value: "Invoices", items: invoiceHits },
      { value: "Campaigns", items: campaignHits },
      { value: "Routing forms", items: routingHits },
      { value: "Jump to a date", items: jump },
      { value: "Start a booking", items: booking },
      { value: "Actions", items: keep(actions) },
      { value: "Go to", items: keep(navigate) },
      { value: `Today's ${t.visits}`, items: visits },
    ].filter((group) => group.items.length > 0);
  }, [appointments, canBook, clinicSlug, database, labels, sections, settingsAvailable, settingsLabel, onOpenHelp, onOpenSettings, openNewVisit, openShortcuts, origin, pathname, patients, router, search.hits, staff, t, text, todayKey]);

  function select(entry: CommandEntry) {
    onOpenChange(false);
    entry.run();
  }

  const status = search.searching ? "Searching…" : search.failed ? "Search is not working right now." : null;

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandDialogPopup>
        <Command items={groups} filter={null} value={query} onValueChange={setQuery} itemToStringValue={(item: unknown) => (typeof item === "object" && item !== null && "label" in item ? String(item.label) : "")}>
          <CommandInput aria-label={`Search ${t.customers}, ${t.visits}, ${t.services}, invoices and actions`} placeholder={`Search ${t.customers}, ${t.visits}, invoices and actions…`} />
          <CommandPanel>
            <CommandEmpty>{status ?? `Nothing found. Try a name, part of a phone number, an invoice number or a date.`}</CommandEmpty>
            <CommandList>
              {(group: CommandEntryGroup) => (
                <Fragment key={group.value}>
                  <CommandGroup items={group.items}>
                    <CommandGroupLabel>{group.value}</CommandGroupLabel>
                    <CommandCollection>
                      {(item: CommandEntry) => (
                        <CommandItem key={item.value} onClick={() => select(item)} value={item.value}>
                          <span className="flex-1">{item.label}</span>
                          {item.shortcut ? <CommandShortcut>{item.shortcut}</CommandShortcut> : null}
                        </CommandItem>
                      )}
                    </CommandCollection>
                  </CommandGroup>
                  <CommandSeparator />
                </Fragment>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <KbdGroup>
                  <Kbd><ArrowUpIcon aria-hidden="true" /></Kbd>
                  <Kbd><ArrowDownIcon aria-hidden="true" /></Kbd>
                </KbdGroup>
                <span>Navigate</span>
              </div>
              <div className="flex items-center gap-2">
                <Kbd><CornerDownLeftIcon aria-hidden="true" /></Kbd>
                <span>Open</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Kbd>Esc</Kbd>
              <span>Close</span>
            </div>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
