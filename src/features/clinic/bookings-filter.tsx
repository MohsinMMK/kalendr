"use client";

import { ListFilter } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { appointmentStatusSchema } from "@/lib/contracts";
import { type BookingFilter, bookingSourceLabels, bookingSources, seriesStatuses, seriesStatusLabels, type WorkspaceTab } from "@/lib/bookings-list";
import type { TermWords } from "@/lib/terminology";

import { dayOfInstant, rangeInstants } from "./bookings-dates";
import { activeFilterCount, type BookingsUrlPatch } from "./bookings-url";
import { statusLabel } from "./clinic-format";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Option { value: string; label: string }

/** Several choices from one dropdown. Nothing chosen means "any". */
function MultiField({ label, any, options, value, onChange }: { label: string; any: string; options: Option[]; value: string[]; onChange: (next: string[]) => void }) {
  const names = new Map(options.map((option) => [option.value, option.label]));
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select multiple items={options} value={value} onValueChange={(next) => onChange(next as string[])}>
        <SelectTrigger size="sm" aria-label={label}>
          <SelectValue>{(chosen: string[]) => chosen.length === 0 ? <span className="text-muted-foreground">{any}</span> : chosen.length <= 2 ? chosen.map((id) => names.get(id) ?? id).join(", ") : `${chosen.length} chosen`}</SelectValue>
        </SelectTrigger>
        <SelectPopup>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectPopup>
      </Select>
    </Field>
  );
}

/** A text box that tells the screen what was typed once typing pauses, so each key does not send a request. */
function DebouncedField({ label, value, placeholder, type = "text", onCommit }: { label: string; value: string; placeholder?: string; type?: string; onCommit: (next: string) => void }) {
  const [state, setState] = useState({ base: value, draft: value });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (state.base !== value) setState({ base: value, draft: value });
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Input size="sm" type={type} aria-label={label} placeholder={placeholder} value={state.draft} onChange={(event) => {
        const next = event.target.value;
        setState({ base: state.base, draft: next });
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => onCommit(next.trim()), 300);
      }} />
    </Field>
  );
}

/**
 * One Filter dropdown for everything: person, service, branch, status, where it was booked, dates, the
 * customer and the campaign. The trigger says how many are on, and Clear turns them all off.
 */
export function BookingFilterMenu({ filter, tab, people, services, branches, timeZone, terms, onChange, onClear, open, onOpenChange }: {
  /** Set when a column header's "Filter" opens this menu. Left out, the menu opens and closes by itself. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The Repeating tab shows only the filters that apply to a series. */
  tab?: WorkspaceTab;
  filter: BookingFilter;
  people: Option[];
  services: Option[];
  branches: Option[];
  timeZone: string;
  terms: TermWords;
  onChange: (patch: BookingsUrlPatch) => void;
  onClear: () => void;
}) {
  const repeating = tab === "repeating";
  const count = activeFilterCount(filter, tab);
  const seriesOptions = seriesStatuses.map((value) => ({ value, label: seriesStatusLabels[value] }));
  const statuses = appointmentStatusSchema.options.map((value) => ({ value, label: statusLabel(value) }));
  const sources = bookingSources.map((value) => ({ value, label: bookingSourceLabels[value] }));
  const fromDay = filter.from ? dayOfInstant(filter.from, timeZone) : "";
  const toDay = filter.to ? dayOfInstant(filter.to, timeZone, 1) : "";
  const list = (next: string[]) => (next.length > 0 ? next : null);
  const setRange = (from: string, to: string) => { const range = rangeInstants(from, to, timeZone); onChange({ from: range.from ?? null, to: range.to ?? null }); };
  const none = (what: string) => `Any ${what}`;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="shrink-0" />}>
        {/* The name comes from what is shown ("Filter 2"): a different spoken label would fail the label-in-name rule. */}
        <ListFilter aria-hidden="true" />Filter
        {count > 0 ? <>{" "}<Badge variant="secondary" size="sm" className="tabular-nums">{count}</Badge></> : null}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-[min(22rem,calc(100vw-2rem))]">
        <ScrollArea className="flex h-auto! max-h-[min(32rem,70svh)] flex-col">
        <div className="flex flex-col gap-3 p-0.5">
          <DebouncedField label={`Search ${terms.customers} by name or phone`} value={filter.q ?? ""} placeholder="Name or phone" onCommit={(next) => onChange({ q: next || null })} />
          <MultiField label={terms.Practitioner} any={none(terms.practitioner)} options={people} value={filter.practitionerIds ?? []} onChange={(next) => onChange({ practitionerIds: list(next) })} />
          <MultiField label="Service" any={none("service")} options={services} value={filter.serviceIds ?? []} onChange={(next) => onChange({ serviceIds: list(next) })} />
          <MultiField label="Branch" any={none("branch")} options={branches} value={filter.locationIds ?? []} onChange={(next) => onChange({ locationIds: list(next) })} />
          {repeating ? <MultiField label="Status" any="Running" options={seriesOptions} value={filter.seriesStatuses ?? []} onChange={(next) => onChange({ seriesStatuses: list(next) })} /> : null}
          {repeating ? null : <MultiField label="Status" any={none("status")} options={statuses} value={filter.statuses ?? []} onChange={(next) => onChange({ statuses: list(next) })} />}
          {repeating ? null : <MultiField label="Booked via" any={none("way")} options={sources} value={filter.sources ?? []} onChange={(next) => onChange({ sources: list(next) })} />}
          {repeating ? null : <div className="grid grid-cols-2 gap-2">
            <Field><FieldLabel>From</FieldLabel><Input size="sm" type="date" aria-label="From date" className="tabular-nums" value={fromDay} max={toDay || undefined} onChange={(event) => setRange(event.target.value, toDay)} /></Field>
            <Field><FieldLabel>To</FieldLabel><Input size="sm" type="date" aria-label="To date" className="tabular-nums" value={toDay} min={fromDay || undefined} onChange={(event) => setRange(fromDay, event.target.value)} /></Field>
          </div>}
          {repeating ? null : <DebouncedField label="Campaign source" value={filter.utmSource ?? ""} placeholder="For example google" onCommit={(next) => onChange({ utmSource: next || null })} />}
          {repeating ? null : <DebouncedField label="Campaign name" value={filter.utmCampaign ?? ""} placeholder="For example spring-offer" onCommit={(next) => onChange({ utmCampaign: next || null })} />}
        </div>
        </ScrollArea>
        <div className="mt-3 flex justify-end border-t pt-3">
          <Button size="sm" variant="ghost" disabled={count === 0} onClick={onClear}>Clear filters</Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
