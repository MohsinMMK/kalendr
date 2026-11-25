"use client";

import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Inbox, Info, ShieldCheck, TriangleAlert } from "lucide-react";
import { z } from "zod";

import { TextField } from "@/components/form-fields";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";

import { useCatalogLookups } from "./clinic-catalog";
import { privacyKeys, saveRetention, useProcessingSummary, useRetentionSettings, type RetentionSettings } from "./queries/privacy";
import { useStepUp } from "./step-up-dialog";

type Policy = RetentionSettings["policies"][number];

function longTime(days: number): string {
  if (days >= 365) {
    const years = Math.round((days / 365) * 10) / 10;
    return `${days} days, about ${years} ${years === 1 ? "year" : "years"}`;
  }
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** Settings, Privacy: how long each kind of information is kept, what is collected and who receives it. */
export function PrivacySettings() {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const live = Boolean(catalog.database);
  const retention = useRetentionSettings(live);
  const summary = useProcessingSummary(live);

  if (!live) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><ShieldCheck aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>Privacy settings need the {t.business} database</EmptyTitle>
          <EmptyDescription>Nothing here is stored in the preview.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      <Frame>
        <FramePanel className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1 basis-64">
            <h3 className="font-heading text-base font-semibold">Privacy requests</h3>
            <p className="text-sm text-muted-foreground">Download, correction and deletion requests from your {t.customers}.</p>
          </div>
          <Button variant="outline" render={<a href="/settings/privacy-requests" />}>
            <Inbox aria-hidden="true" /> Open privacy requests <ArrowRight aria-hidden="true" />
          </Button>
        </FramePanel>
      </Frame>

      <RetentionCard query={retention} />

      <Frame>
        <FrameHeader>
          <FrameTitle>What you collect and who receives it</FrameTitle>
          <FrameDescription>A starting point for your own privacy notice. Check it with your adviser.</FrameDescription>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-5">
          {summary.isPending ? <div role="status" aria-label="Loading summary" className="flex flex-col gap-2"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-5 w-1/2" /><Skeleton className="h-5 w-3/4" /></div> : null}
          {summary.isError ? (
            <Alert variant="error">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>
                <p>{summary.error instanceof Error ? summary.error.message : "The summary could not be loaded."}</p>
                <Button variant="outline" size="sm" className="self-start" onClick={() => void summary.refetch()}>Try again</Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {summary.data ? (
            <>
              <section aria-labelledby="privacy-collected" className="flex flex-col gap-2">
                <h4 id="privacy-collected" className="text-sm font-medium">What is collected</h4>
                <ul className="flex flex-col divide-y rounded-lg border">
                  {summary.data.collected.map((item) => (
                    <li key={item.what} className="flex flex-col gap-0.5 px-3 py-2.5 text-sm">
                      <p className="font-medium">{item.what}</p>
                      <p className="text-muted-foreground">{item.why}</p>
                      <p className="text-xs text-muted-foreground">Kept: {item.keptFor}</p>
                    </li>
                  ))}
                </ul>
              </section>
              <section aria-labelledby="privacy-shared" className="flex flex-col gap-2">
                <h4 id="privacy-shared" className="text-sm font-medium">Who receives it</h4>
                <ul className="flex flex-col divide-y rounded-lg border">
                  {summary.data.sharedWith.map((item) => (
                    <li key={item.provider} className="flex flex-col gap-1 px-3 py-2.5 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium">{item.provider}</p>
                        <StatusBadge tone={item.active ? "success" : "neutral"}>{item.active ? "In use" : "Not in use yet"}</StatusBadge>
                      </div>
                      <p className="text-muted-foreground">{item.receives}</p>
                      <p className="text-xs text-muted-foreground">{item.why}</p>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          ) : null}
        </FramePanel>
      </Frame>

      <Alert variant="info" role="note">
        <Info aria-hidden="true" />
        <AlertTitle>Your privacy notice</AlertTitle>
        <AlertDescription>
          Your {t.customers} see Kalendr&apos;s built-in notice, in English and Hindi. You cannot edit it here yet, and it does not yet carry your own business details. Have your adviser read it before you rely on it. Kalendr gives you tools to help you meet your duties. It does not meet them for you.
        </AlertDescription>
      </Alert>
    </>
  );
}

function RetentionCard({ query }: { query: ReturnType<typeof useRetentionSettings> }) {
  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>How long information is kept</FrameTitle>
        <FrameDescription>Kalendr removes old information every night. These are starting points, not legal advice.</FrameDescription>
      </FrameHeader>
      {query.isPending ? (
        <FramePanel><div role="status" aria-label="Loading retention periods" className="flex flex-col gap-3"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div></FramePanel>
      ) : query.isError ? (
        <FramePanel>
          <Alert variant="error">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>
              <p>{query.error instanceof Error ? query.error.message : "The retention periods could not be loaded."}</p>
              <Button variant="outline" size="sm" className="self-start" onClick={() => void query.refetch()}>Try again</Button>
            </AlertDescription>
          </Alert>
        </FramePanel>
      ) : (
        <RetentionForm key={JSON.stringify(query.data.policies.map((policy) => [policy.dataKind, policy.keepDays]))} policies={query.data.policies} />
      )}
    </Frame>
  );
}

function RetentionForm({ policies }: { policies: Policy[] }) {
  const queryClient = useQueryClient();
  const { runWithStepUp } = useStepUp();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(policies.map((policy) => [policy.dataKind, String(policy.keepDays)])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError("");
    const found: Record<string, string> = {};
    const changed: { dataKind: string; keepDays: number; action: string }[] = [];
    for (const policy of policies) {
      if (!policy.editable) continue;
      const min = policy.minDays ?? 1;
      const max = policy.maxDays ?? 36_500;
      const parsed = z.coerce.number().int().min(min).max(max).safeParse(values[policy.dataKind]?.trim() === "" ? Number.NaN : values[policy.dataKind]);
      if (!parsed.success) {
        found[policy.dataKind] = `Enter a whole number of days from ${min} to ${max}.`;
      } else if (parsed.data !== policy.keepDays) {
        changed.push({ dataKind: policy.dataKind, keepDays: parsed.data, action: policy.action });
      }
    }
    setErrors(found);
    if (Object.keys(found).length) return;
    if (!changed.length) {
      setFormError("Nothing has changed yet.");
      return;
    }
    setPending(true);
    try {
      const saved = await runWithStepUp(() => saveRetention(changed));
      queryClient.setQueryData(privacyKeys.retention(), saved);
      await queryClient.invalidateQueries({ queryKey: privacyKeys.summary() });
      toastManager.add({ title: "Retention saved", description: "The nightly clean-up uses these periods from now on.", type: "success" });
    } catch (cause: unknown) {
      setFormError(cause instanceof Error ? cause.message : "The periods could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate>
      <FramePanel className="flex flex-col gap-5">
        {formError ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{formError}</AlertDescription></Alert> : null}
        {policies.map((policy) => policy.editable ? (
          <TextField
            key={policy.dataKind}
            label={policy.label ?? policy.dataKind}
            hint={`${policy.description ?? ""} Between ${policy.minDays} and ${policy.maxDays} days. Now: ${longTime(policy.keepDays)}.`.trim()}
            error={errors[policy.dataKind]}
            type="number"
            inputMode="numeric"
            min={policy.minDays}
            max={policy.maxDays}
            fieldClassName="max-w-sm"
            value={values[policy.dataKind] ?? ""}
            onChange={(event) => setValues((current) => ({ ...current, [policy.dataKind]: event.target.value }))}
          />
        ) : (
          <div key={policy.dataKind} className="flex flex-col gap-0.5 text-sm">
            <p className="font-medium">{policy.label ?? policy.dataKind}</p>
            <p className="text-muted-foreground">{policy.description} Fixed at {longTime(policy.keepDays)}.</p>
          </div>
        ))}
      </FramePanel>
      <FrameFooter className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">Saving asks for a fresh code from your authenticator app.</p>
        <Button type="submit" disabled={pending}>{pending ? <Spinner aria-hidden="true" /> : null}Save retention periods</Button>
      </FrameFooter>
    </form>
  );
}
