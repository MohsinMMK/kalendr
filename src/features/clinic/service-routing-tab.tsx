"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { UsersRound, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { RadioCard } from "@/features/booking/radio-card";
import { useTerms } from "@/features/terms/business-profile-context";
import { assignmentLabels, assignmentModes, serviceRoutingSchema, type AssignmentMode, type ServiceRoutingView } from "@/lib/routing-contracts";

import { staffKeys } from "./queries/keys";
import { StaffApiError, staffMutation, staffQuery } from "./queries/http";
import type { ServiceEditorContext } from "./service-editor-tabs";
import { SettingRow } from "./setting-row";

interface Row { practitionerId: string; name: string; priority: string; weight: string }
interface Draft { assignment: AssignmentMode; preferReturningPerson: boolean; rows: Row[] }

const routingKey = (serviceId: string) => [...staffKeys.all, "routing", "service", serviceId] as const;

function draftFrom(view: ServiceRoutingView): Draft {
  return {
    assignment: view.assignment,
    preferReturningPerson: view.preferReturningPerson,
    rows: view.people.map((person) => ({ practitionerId: person.practitionerId, name: person.name, priority: String(person.priority), weight: String(person.weight) })),
  };
}

function whole(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

/** The share each person takes, as whole percents of the weights typed so far. A weight that is not valid counts as nothing. */
export function sharesFromWeights(weights: ReadonlyArray<number | null>): number[] {
  const total = weights.reduce<number>((sum, weight) => sum + (weight ?? 0), 0);
  return weights.map((weight) => (total > 0 && weight ? Math.round((weight / total) * 100) : 0));
}

/** The service editor's Team routing tab: who a booking goes to, with its own Save and version check. */
export function ServiceRoutingTab({ serviceId, saves }: Pick<ServiceEditorContext, "serviceId" | "saves">) {
  const t = useTerms();
  const query = useQuery({
    queryKey: routingKey(serviceId),
    queryFn: ({ signal }) => staffQuery<ServiceRoutingView>(`/api/staff/routing/services/${serviceId}`, signal),
    enabled: saves,
  });

  if (!saves) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><UsersRound aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>Team routing needs the live database</EmptyTitle>
          <EmptyDescription>Who gets a booking is not saved in the preview.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (query.isPending) {
    return <div role="status" aria-label="Loading team routing" className="flex flex-col gap-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-11 w-full" /></div>;
  }
  if (query.isError) {
    return (
      <Alert variant="error">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Team routing could not be loaded</AlertTitle>
        <AlertDescription>
          <p>{query.error instanceof Error ? query.error.message : "Something went wrong."}</p>
          <Button type="button" size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void query.refetch()}>Try again</Button>
        </AlertDescription>
      </Alert>
    );
  }
  return <RoutingForm key={query.data.version} serviceId={serviceId} view={query.data} termsProvider={t.provider} termsProviders={t.providers} />;
}

function RoutingForm({ serviceId, view, termsProvider, termsProviders }: { serviceId: string; view: ServiceRoutingView; termsProvider: string; termsProviders: string }) {
  const queryClient = useQueryClient();
  const baseId = useId();
  const initial = draftFrom(view);
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const weights = draft.rows.map((row) => whole(row.weight, 1, 100));
  const shares = sharesFromWeights(weights);
  const invalid = draft.rows.some((row) => whole(row.priority, 0, 100) === null || whole(row.weight, 1, 100) === null);

  function setRow(index: number, patch: Partial<Row>) {
    setDraft((current) => ({ ...current, rows: current.rows.map((row, at) => (at === index ? { ...row, ...patch } : row)) }));
  }

  async function reload() {
    setConflict(false);
    setMessage("");
    await queryClient.invalidateQueries({ queryKey: routingKey(serviceId) });
  }

  async function save() {
    const parsed = serviceRoutingSchema.safeParse({
      assignment: draft.assignment,
      preferReturningPerson: draft.preferReturningPerson,
      people: draft.rows.map((row) => ({ practitionerId: row.practitionerId, priority: whole(row.priority, 0, 100), weight: whole(row.weight, 1, 100) })),
      expectedVersion: view.version,
    });
    if (!parsed.success) {
      setMessage("Priority must be 0 to 100 and weight 1 to 100.");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const saved = await staffMutation<ServiceRoutingView>(`/api/staff/routing/services/${serviceId}`, "PUT", parsed.data);
      queryClient.setQueryData(routingKey(serviceId), saved);
      toastManager.add({ title: "Team routing saved. New bookings use it.", type: "success" });
    } catch (cause: unknown) {
      if (cause instanceof StaffApiError && cause.code === "version_conflict") setConflict(true);
      else setMessage(cause instanceof Error ? cause.message : "Team routing could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    // No <form> here: this tab sits inside the editor's form and saves on its own.
    <div onKeyDown={(event) => { if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault(); }}>
    <SettingRow settingId="routing" title="Team routing" help={`Who gets a booking for ${view.serviceName}. This tab has its own Save.`}>
      {conflict ? (
        <Alert variant="warning">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Someone else changed this</AlertTitle>
          <AlertDescription>
            <p>Load the latest routing, then make your change again.</p>
            <Button type="button" size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void reload()}>Load the latest</Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium text-sm">Who gets a booking</legend>
        <RadioGroup value={draft.assignment} onValueChange={(next) => setDraft((current) => ({ ...current, assignment: assignmentModes.find((mode) => mode === next) ?? current.assignment }))} aria-label="Who gets a booking">
          {assignmentModes.map((mode) => (
            <RadioCard key={mode} value={mode}>
              <span className="flex min-w-0 flex-col gap-0.5"><span className="font-medium text-sm">{assignmentLabels[mode].label}</span><span className="text-muted-foreground text-xs">{assignmentLabels[mode].hint}</span></span>
            </RadioCard>
          ))}
        </RadioGroup>
      </fieldset>
      <SettingRow settingId="routing" className="rounded-xl border px-3 py-1 last:border-b" title={`Keep returning customers with the same ${termsProvider}`} help="Give them the person they saw last time, when that person is free."
        checked={draft.preferReturningPerson} onCheckedChange={(checked) => setDraft((current) => ({ ...current, preferReturningPerson: checked }))} />
      <div className="flex flex-col gap-2">
        <h4 className="font-medium text-sm">Priority and share</h4>
        <p className="text-muted-foreground text-xs">Higher priority goes first. Weight is a share: 2 takes twice as many as 1.</p>
        {draft.rows.length === 0 ? (
          <p className="rounded-lg border border-dashed p-3 text-muted-foreground text-sm">No {termsProviders} offer this yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {draft.rows.map((row, index) => {
              const priorityBad = whole(row.priority, 0, 100) === null;
              const weightBad = weights[index] === null;
              return (
                <li key={row.practitionerId} className="flex flex-wrap items-end gap-3 rounded-xl border p-3">
                  <div className="min-w-32 flex-1 basis-32">
                    <p className="truncate font-medium text-sm">{row.name}</p>
                    <p className="text-muted-foreground text-xs" aria-live="polite">takes about {shares[index]}%</p>
                  </div>
                  <div className="flex w-20 flex-col gap-1">
                    <Label htmlFor={`${baseId}-p-${index}`} className="text-xs">Priority</Label>
                    <Input id={`${baseId}-p-${index}`} type="number" inputMode="numeric" min={0} max={100} className="min-h-11" aria-label={`Priority for ${row.name}`} aria-invalid={priorityBad} value={row.priority} onChange={(event) => setRow(index, { priority: event.target.value })} />
                  </div>
                  <div className="flex w-20 flex-col gap-1">
                    <Label htmlFor={`${baseId}-w-${index}`} className="text-xs">Weight</Label>
                    <Input id={`${baseId}-w-${index}`} type="number" inputMode="numeric" min={1} max={100} className="min-h-11" aria-label={`Weight for ${row.name}`} aria-invalid={weightBad} value={row.weight} onChange={(event) => setRow(index, { weight: event.target.value })} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="flex justify-end">
        <Button type="button" size="lg" className="min-h-11" loading={saving} disabled={!dirty || invalid} onClick={() => void save()}>Save team routing</Button>
      </div>
    </SettingRow>
    </div>
  );
}
