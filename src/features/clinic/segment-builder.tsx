"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Plus, X } from "lucide-react";
import { useState } from "react";

import { OptionSelect, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { amountInputValue, parseAmountInput } from "@/lib/money";
import {
  MAX_SEGMENT_CONDITIONS, defaultCondition, describeFilter, isConditionComplete, segmentFieldLabels, segmentFieldOrder,
  type SegmentCondition, type SegmentFilter, type SegmentSummary,
} from "@/lib/segment-filter";

import { useCatalogLookups } from "./clinic-catalog";
import { errorText } from "./customer-parts";
import { customerKeys, useCustomerTags, useSegmentCount } from "./queries/customers";
import { StaffApiError, staffMutation } from "./queries/http";
import { ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";

const countOps = [
  { value: "gt", label: "more than" }, { value: "gte", label: "at least" }, { value: "lt", label: "fewer than" }, { value: "lte", label: "at most" }, { value: "eq", label: "exactly" },
];
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function countOp(value: string): "gt" | "gte" | "lt" | "lte" | "eq" {
  return value === "gte" || value === "lt" || value === "lte" || value === "eq" ? value : "gt";
}

/** A dropdown of checkboxes: the rich alternative to a row of toggle buttons for choosing several services or tags. */
function MultiPick({ label, options, value, onChange, empty }: { label: string; options: { id: string; name: string }[]; value: string[]; onChange: (next: string[]) => void; empty: string }) {
  const names = options.filter((option) => value.includes(option.id)).map((option) => option.name);
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" className="min-h-11 min-w-0 flex-1 justify-between sm:min-h-9" aria-label={label} />}>
        <span className="truncate">{names.length === 0 ? "Choose…" : names.length <= 2 ? names.join(", ") : `${names.length} chosen`}</span>
        <ChevronDown aria-hidden="true" />
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-64">
        {options.length === 0 ? <p className="text-muted-foreground text-sm">{empty}</p> : (
          <ScrollAreaPrimitive.Root><ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className="max-h-64 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"><ScrollAreaPrimitive.Content style={{ minWidth: 0 }}><ul aria-label={label} className="flex flex-col">
            {options.map((option) => (
              <li key={option.id}>
                <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-1 hover:bg-accent sm:min-h-8">
                  <Checkbox checked={value.includes(option.id)} onCheckedChange={(checked) => onChange(checked ? [...value, option.id] : value.filter((id) => id !== option.id))} />
                  <span className="truncate text-sm">{option.name}</span>
                </label>
              </li>
            ))}
          </ul></ScrollAreaPrimitive.Content></ScrollAreaPrimitive.Viewport><ScrollBar orientation="vertical" /></ScrollAreaPrimitive.Root>
        )}
      </PopoverPopup>
    </Popover>
  );
}

function ConditionRow({ condition, onChange, onRemove, index }: { condition: SegmentCondition; onChange: (next: SegmentCondition) => void; onRemove: () => void; index: number }) {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const tags = useCustomerTags();
  const row = `Condition ${index + 1}`;
  const control = (() => {
    switch (condition.field) {
      case "lastVisit":
        return (
          <>
            <OptionSelect aria-label={`${row} when`} size="default" className="min-w-0 flex-1" value={condition.op} onValueChange={(op) => onChange(op === "never" ? { field: "lastVisit", op: "never" } : op === "before" || op === "after" ? { field: "lastVisit", op, date: condition.date ?? "" } : { field: "lastVisit", op: op === "withinDays" ? "withinDays" : "olderThanDays", days: condition.days ?? 90 })}
              options={[{ value: "olderThanDays", label: "No visit in the last" }, { value: "withinDays", label: "Visited in the last" }, { value: "before", label: "Last visit before" }, { value: "after", label: "Last visit after" }, { value: "never", label: "Has never had a visit" }]} />
            {condition.op === "olderThanDays" || condition.op === "withinDays"
              ? <span className="flex items-center gap-2"><Input aria-label={`${row} days`} type="number" min={1} max={5000} className="w-24" value={condition.days ?? ""} onChange={(event) => onChange({ ...condition, days: event.target.value === "" ? undefined : Number(event.target.value) })} /><span className="text-sm">days</span></span> : null}
            {condition.op === "before" || condition.op === "after" ? <Input aria-label={`${row} date`} type="date" className="w-40" value={condition.date ?? ""} onChange={(event) => onChange({ ...condition, date: event.target.value || undefined })} /> : null}
          </>
        );
      case "visits":
        return (
          <>
            <OptionSelect aria-label={`${row} comparison`} size="default" className="min-w-0 flex-1" value={condition.op} onValueChange={(op) => onChange({ ...condition, op: countOp(op) })} options={countOps} />
            <Input aria-label={`${row} number of visits`} type="number" min={0} className="w-24" value={condition.value} onChange={(event) => onChange({ ...condition, value: Math.max(0, Math.floor(Number(event.target.value) || 0)) })} />
          </>
        );
      case "service":
        return (
          <>
            <OptionSelect aria-label={`${row} service rule`} size="default" className="min-w-0 flex-1" value={condition.op} onValueChange={(op) => onChange({ ...condition, op: op === "notUsed" ? "notUsed" : "used" })} options={[{ value: "used", label: "Has had" }, { value: "notUsed", label: "Has not had" }]} />
            <MultiPick label={`${row} ${t.services}`} options={catalog.services.map((service) => ({ id: service.id, name: service.name }))} value={condition.serviceIds} onChange={(serviceIds) => onChange({ ...condition, serviceIds })} empty={`No ${t.services} yet.`} />
          </>
        );
      case "tag":
        return (
          <>
            <OptionSelect aria-label={`${row} tag rule`} size="default" className="min-w-0 flex-1" value={condition.op} onValueChange={(op) => onChange({ ...condition, op: op === "hasNot" ? "hasNot" : "has" })} options={[{ value: "has", label: "Has the tag" }, { value: "hasNot", label: "Does not have the tag" }]} />
            <MultiPick label={`${row} tags`} options={(tags.data ?? []).map((tag) => ({ id: tag.id, name: tag.name }))} value={condition.tagIds} onChange={(tagIds) => onChange({ ...condition, tagIds })} empty="No tags yet. Make one on a profile." />
          </>
        );
      case "spend":
        return (
          <>
            <OptionSelect aria-label={`${row} comparison`} size="default" className="min-w-0 flex-1" value={condition.op} onValueChange={(op) => onChange({ ...condition, op: countOp(op) })} options={countOps} />
            <Input aria-label={`${row} amount spent`} inputMode="decimal" className="w-28" defaultValue={amountInputValue(condition.valueMinor)} onChange={(event) => { const minor = parseAmountInput(event.target.value); if (minor !== null) onChange({ ...condition, valueMinor: minor }); }} />
          </>
        );
      case "futureBooking":
        return <OptionSelect aria-label={`${row} answer`} size="default" className="min-w-0 flex-1" value={condition.value ? "yes" : "no"} onValueChange={(next) => onChange({ ...condition, value: next === "yes" })} options={[{ value: "yes", label: `Has a ${t.appointment} coming up` }, { value: "no", label: `Has no ${t.appointment} coming up` }]} />;
      case "birthdayMonth":
        return <OptionSelect aria-label={`${row} month`} size="default" className="min-w-0 flex-1" value={String(condition.month)} onValueChange={(next) => onChange({ ...condition, month: Number(next) })} options={months.map((month, at) => ({ value: String(at + 1), label: `Birthday in ${month}` }))} />;
      case "marketingConsent":
        return <OptionSelect aria-label={`${row} answer`} size="default" className="min-w-0 flex-1" value={condition.value ? "yes" : "no"} onValueChange={(next) => onChange({ ...condition, value: next === "yes" })} options={[{ value: "yes", label: "Has agreed to marketing messages" }, { value: "no", label: "Has not agreed to marketing messages" }]} />;
    }
  })();
  return (
    <div role="group" className="flex flex-wrap items-center gap-2 rounded-lg border p-2" aria-label={row}>
      <div className="w-full sm:w-44">
        <OptionSelect aria-label={`${row} field`} size="default" value={condition.field} onValueChange={(field) => { const next = segmentFieldOrder.find((item) => item === field); if (next && next !== condition.field) onChange(defaultCondition(next)); }} options={segmentFieldOrder.map((field) => ({ value: field, label: segmentFieldLabels[field] }))} />
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{control}</div>
      <Button type="button" variant="ghost" size="icon" className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8" aria-label={`Remove ${row.toLowerCase()}`} onClick={onRemove}><X aria-hidden="true" /></Button>
    </div>
  );
}

/**
 * Builds or changes a saved segment: plain conditions joined by "and", with the count shown as it is built.
 * A condition that still needs a choice (a service, a tag) holds the count and the save back until it has one.
 */
export function SegmentBuilder({ segment, open, onOpenChange }: { segment: SegmentSummary | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTerms();
  const client = useQueryClient();
  const catalog = useCatalogLookups();
  const tags = useCustomerTags(open);
  const [name, setName] = useState(segment?.name ?? "");
  const [conditions, setConditions] = useState<SegmentCondition[]>(segment?.filter.all ?? [defaultCondition("lastVisit")]);
  const [nameError, setNameError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const filter: SegmentFilter = { all: conditions };
  const complete = conditions.every(isConditionComplete)
    && conditions.every((condition) => condition.field !== "lastVisit" || (condition.op === "never" || condition.op === "before" || condition.op === "after" ? (condition.op === "never" || Boolean(condition.date)) : Boolean(condition.days)));
  const count = useSegmentCount(filter, open && complete);
  const sentence = describeFilter(filter, {
    serviceName: (id) => catalog.serviceName(id),
    tagName: (id) => tags.data?.find((tag) => tag.id === id)?.name ?? "",
    money: (minor) => `₹${amountInputValue(minor)}`,
  });

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setNameError(""); setMessage("");
    if (!name.trim()) { setNameError("Give the segment a name."); return; }
    if (!complete) { setMessage("Finish each condition first."); return; }
    setBusy(true);
    try {
      if (segment) await staffMutation(`/api/staff/segments/${encodeURIComponent(segment.id)}`, "PUT", { name: name.trim(), filter, version: segment.version });
      else await staffMutation("/api/staff/segments", "POST", { name: name.trim(), filter });
      await client.invalidateQueries({ queryKey: customerKeys.segments() });
      toastManager.add({ title: segment ? "Segment saved" : "Segment created", description: name.trim(), type: "success" });
      onOpenChange(false);
    } catch (cause: unknown) {
      if (cause instanceof StaffApiError && cause.fieldErrors.name?.[0]) setNameError(cause.fieldErrors.name[0]);
      else setMessage(errorText(cause, "The segment could not be saved. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <form noValidate aria-label={segment ? "Change segment" : "New segment"} className="contents" onSubmit={(event) => void save(event)}>
          <DialogHeader>
            <DialogTitle>{segment ? "Change segment" : "New segment"}</DialogTitle>
            <DialogDescription>A segment is a saved list of {t.customers}. Everyone who matches every condition below is in it, and the list keeps itself up to date.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
            <TextField label="Name" value={name} maxLength={80} error={nameError} onChange={(event) => setName(event.target.value)} placeholder="Regulars we have lost touch with" />
            <ol aria-label="Conditions" className="flex flex-col gap-2">
              {conditions.map((condition, index) => (
                <li key={index} className="flex flex-col gap-2">
                  <ConditionRow index={index} condition={condition} onChange={(next) => setConditions((current) => current.map((item, at) => (at === index ? next : item)))} onRemove={() => setConditions((current) => current.filter((_, at) => at !== index))} />
                  {index < conditions.length - 1 ? <span aria-hidden="true" className="ps-2 text-muted-foreground text-xs uppercase tracking-wide">and</span> : null}
                </li>
              ))}
            </ol>
            {conditions.length === 0 ? <p className="text-muted-foreground text-sm">No conditions: everyone is in this segment.</p> : null}
            {conditions.length < MAX_SEGMENT_CONDITIONS ? <Button type="button" variant="outline" size="sm" className="min-h-11 self-start sm:min-h-8" onClick={() => setConditions((current) => [...current, defaultCondition("visits")])}><Plus aria-hidden="true" />Add a condition</Button> : null}
            <div className="rounded-lg bg-muted/50 p-3" aria-live="polite">
              <p className="text-muted-foreground text-xs">{sentence}</p>
              <p role="status" className="mt-1 flex items-center gap-2 font-medium text-sm">
                {!complete ? `Finish each condition to see how many ${t.customers} match.`
                  : count.isError ? <span className="text-destructive-foreground">The count could not be worked out. <button type="button" className="underline" onClick={() => void count.refetch()}>Try again</button></span>
                  : count.data === undefined ? <><Spinner />Counting…</>
                  : <><span className="tabular-nums" data-testid="segment-count">{count.data.count}</span> {count.data.count === 1 ? t.customer : t.customers} match{count.isFetching ? <Spinner /> : null}</>}
              </p>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? <Spinner /> : null}{segment ? "Save segment" : "Create segment"}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
