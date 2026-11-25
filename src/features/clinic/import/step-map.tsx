"use client";

import { ArrowRight, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { SelectField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Label } from "@/components/ui/label";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useTerms } from "@/features/terms/business-profile-context";

import { isVersionConflict, useSaveMapping, useStartCheck } from "./api";
import { dateFormats, defaultOptions, type DateFormat, type DuplicateRule, type ImportField, type ImportJob, type ImportMapping, type ImportOptions, type PreviewRow } from "./types";
import { kindWords } from "./words";
import { ScrollArea } from "@/components/ui/scroll-area";

const countries: { value: NonNullable<ImportOptions["defaultCountry"]>; label: string }[] = [
  { value: "IN", label: "India (+91)" },
  { value: "GB", label: "United Kingdom (+44)" },
  { value: "US", label: "United States (+1)" },
  { value: "AE", label: "United Arab Emirates (+971)" },
  { value: "AU", label: "Australia (+61)" },
  { value: "CA", label: "Canada (+1)" },
  { value: "SG", label: "Singapore (+65)" },
  { value: "NZ", label: "New Zealand (+64)" },
  { value: "ZA", label: "South Africa (+27)" },
];

/** Column choices: each header once, with its place when two columns share a name. */
export function columnOptions(headers: string[]): { value: string; label: string }[] {
  const seen = new Map<string, number>();
  for (const header of headers) seen.set(header, (seen.get(header) ?? 0) + 1);
  return [
    { value: "", label: "Don't import" },
    ...headers.map((header, index) => {
      const name = header.trim() || `Column ${index + 1}`;
      return { value: String(index), label: (seen.get(header) ?? 0) > 1 ? `${name} (column ${index + 1})` : name };
    }),
  ];
}

export interface MapStepProps {
  job: ImportJob;
  headers: string[];
  fields: ImportField[];
  suggestedMapping: ImportMapping;
  onChecking: () => void;
  onConflict: () => void;
}

export function isConsentField(field: ImportField): boolean {
  return /consent/i.test(field.key);
}

export function MapStep({ job, headers, fields, suggestedMapping, onChecking, onConflict }: MapStepProps) {
  const t = useTerms();
  const words = kindWords(job.kind, t);
  const save = useSaveMapping(job.id);
  const check = useStartCheck(job.id);
  const [mapping, setMapping] = useState<ImportMapping>(() => (job.mapping && Object.keys(job.mapping).length ? job.mapping : suggestedMapping));
  const [options, setOptions] = useState<ImportOptions>(() => ({ ...defaultOptions, ...job.options }));
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [problem, setProblem] = useState("");
  const columns = useMemo(() => columnOptions(headers), [headers]);

  const missing = fields.filter((field) => field.required && mapping[field.key] == null);
  const consentField = job.kind === "customers" ? fields.find(isConsentField) : undefined;
  const consentMapped = consentField !== undefined && mapping[consentField.key] != null;
  const needsConsent = consentMapped && !options.consentConfirmed;
  const canContinue = missing.length === 0 && !needsConsent;

  // Saves go one at a time and each reads the newest version, so quick edits never fight each other.
  const version = useRef(job.version);
  useEffect(() => { version.current = job.version; }, [job.version]);
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  function saveNow(nextMapping: ImportMapping, nextOptions: ImportOptions) {
    const run = chain.current.then(() => save.mutateAsync({ mapping: nextMapping, options: nextOptions, expectedVersion: version.current }));
    chain.current = run.catch(() => undefined);
    return run;
  }

  const draftKey = JSON.stringify([mapping, options]);
  const required = missing.length === 0;
  useEffect(() => {
    if (!required) return;
    const timer = window.setTimeout(() => {
      setPreviewing(true);
      saveNow(mapping, options)
        .then((result) => { setPreview(result.preview); setProblem(""); })
        .catch((error: unknown) => {
          if (isVersionConflict(error)) onConflict();
          else setProblem(error instanceof Error ? error.message : "Your choices could not be saved.");
        })
        .finally(() => setPreviewing(false));
    }, 450);
    return () => window.clearTimeout(timer);
    // The draft is the trigger; saveNow only reads refs and stable mutation functions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, required]);

  async function proceed() {
    setProblem("");
    try {
      await saveNow(mapping, options);
      await check.mutateAsync();
      onChecking();
    } catch (error: unknown) {
      if (isVersionConflict(error)) onConflict();
      else setProblem(error instanceof Error ? error.message : "The check could not start. Try again.");
    }
  }

  const setOption = <K extends keyof ImportOptions>(key: K, value: ImportOptions[K]) => setOptions((current) => ({ ...current, [key]: value }));
  const shownFields = fields.filter((field) => mapping[field.key] != null);
  const working = save.isPending || check.isPending;

  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>Match your columns</FrameTitle>
        <FrameDescription>We guessed which column holds each detail. Change any that look wrong. Details you don&apos;t need can be left as &quot;Don&apos;t import&quot;.</FrameDescription>
      </FrameHeader>
      <FramePanel className="grid gap-4 md:grid-cols-2">
        {fields.map((field) => (
          <SelectField
            key={field.key}
            label={<>{field.label}{field.required ? <Badge variant="outline" size="sm" className="ms-2">Required</Badge> : null}</>}
            hint={field.description}
            value={mapping[field.key] == null ? "" : String(mapping[field.key])}
            onValueChange={(next) => setMapping((current) => ({ ...current, [field.key]: next === "" ? null : Number(next) }))}
            options={columns}
          />
        ))}
      </FramePanel>

      <FramePanel className="flex flex-col gap-5">
        {job.kind !== "services" ? (
          <div className="grid gap-4 md:grid-cols-2">
            <SelectField label="Date format in your file" hint="How days and months are written, so 03/04/2026 is read the right way round." value={options.dateFormat} onValueChange={(next) => setOption("dateFormat", next as DateFormat)} options={dateFormats} />
            <SelectField label="Phone numbers without a country code" hint="These are read as numbers from this country." value={options.defaultCountry ?? "IN"} onValueChange={(next) => { const match = countries.find((country) => country.value === next); if (match) setOption("defaultCountry", match.value); }} options={countries} />
          </div>
        ) : null}

        {job.kind !== "appointments" ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">If a {job.kind === "customers" ? t.customer : t.service} is already in your list</legend>
            <RadioGroup aria-label={`If a ${job.kind === "customers" ? t.customer : t.service} is already in your list`} value={options.duplicateRule} onValueChange={(next) => setOption("duplicateRule", next as DuplicateRule)}>
              <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 has-data-checked:border-primary/48 has-data-checked:bg-accent/50 has-focus-visible:ring-2 has-focus-visible:ring-ring">
                <Radio value="skip" className="mt-0.5" />
                <span><span className="block text-sm font-medium">Skip duplicates</span><span className="block text-xs text-muted-foreground">Leave the existing record exactly as it is.</span></span>
              </label>
              <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 has-data-checked:border-primary/48 has-data-checked:bg-accent/50 has-focus-visible:ring-2 has-focus-visible:ring-ring">
                <Radio value="fill_blanks" className="mt-0.5" />
                <span><span className="block text-sm font-medium">Fill in blanks only</span><span className="block text-xs text-muted-foreground">Add details the existing record is missing. Nothing already there is changed.</span></span>
              </label>
            </RadioGroup>
          </fieldset>
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <Label htmlFor="import-send-confirmations" className="font-medium">Send confirmations</Label>
              <p className="text-xs text-muted-foreground">Off by default. Turn it on to message each {t.customer} about the {t.appointment} you import.</p>
            </div>
            <Switch id="import-send-confirmations" checked={options.sendConfirmations} onCheckedChange={(next) => setOption("sendConfirmations", next)} />
          </div>
        )}

        {consentField && consentMapped ? (
          <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 has-focus-visible:ring-2 has-focus-visible:ring-ring">
            <Checkbox className="mt-0.5" checked={options.consentConfirmed} onCheckedChange={(next) => setOption("consentConfirmed", next === true)} />
            <span>
              <span className="block text-sm font-medium">I confirm these {t.customers} agreed to receive messages</span>
              <span className="block text-xs text-muted-foreground">Required because your file has a consent column. Only people marked as agreeing in the file get texts and WhatsApp messages. Everyone else gets email only.</span>
            </span>
          </label>
        ) : null}
      </FramePanel>

      <FramePanel className="flex flex-col gap-3">
        <div>
          <h3 className="font-heading text-sm font-semibold">What will be saved</h3>
          <p className="text-xs text-muted-foreground">The first five rows of your file, as they will be saved.</p>
        </div>
        {missing.length ? (
          <p className="text-sm text-muted-foreground" role="status">Match {missing.map((field) => field.label).join(", ")} to see a preview.</p>
        ) : preview === null ? (
          <div className="flex flex-col gap-2" role="status" aria-label="Loading preview"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
        ) : preview.length === 0 ? (
          <p className="text-sm text-muted-foreground" role="status">Nothing to show yet. Check that the right columns are matched.</p>
        ) : (
          <ScrollArea clampContentMinWidth={false}><Table render={<div className="relative w-full overflow-visible!" />} aria-label={`First rows of your ${words.noun}, as they will be saved`} aria-busy={previewing}>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Row</TableHead>
                {shownFields.map((field) => <TableHead key={field.key}>{field.label}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.map((row) => (
                <TableRow key={row.rowNumber}>
                  <TableCell className="tabular-nums">{row.rowNumber}</TableCell>
                  {shownFields.map((field) => <TableCell key={field.key} className="max-w-48 truncate">{row.values[field.key] || <span className="text-muted-foreground">Empty</span>}</TableCell>)}
                </TableRow>
              ))}
            </TableBody>
          </Table></ScrollArea>
        )}
      </FramePanel>

      {problem ? <FramePanel><Alert variant="error" role="alert"><TriangleAlert aria-hidden="true" /><AlertDescription>{problem}</AlertDescription></Alert></FramePanel> : null}
      <FrameFooter className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" role="status">
          {missing.length ? `Still to match: ${missing.map((field) => field.label).join(", ")}.` : needsConsent ? "Tick the confirmation above to continue." : ""}
        </p>
        <Button onClick={proceed} disabled={!canContinue || working}>
          {working ? <Spinner aria-hidden="true" /> : null}
          Check the file <ArrowRight aria-hidden="true" />
        </Button>
      </FrameFooter>
    </Frame>
  );
}
