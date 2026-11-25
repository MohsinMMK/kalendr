"use client";

import { FileUp, LockKeyhole, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { parseAsString, useQueryState } from "nuqs";
import { useEffect, useRef, useState } from "react";

import type { ActionMenuEntry, BarAction } from "@/components/action-bar";
import { WorkspacePage } from "@/components/workspace-page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useTerms } from "@/features/terms/business-profile-context";

import { useCatalogLookups } from "./clinic-catalog";
import { isPolling, recallSetup, sampleUrl, useDiscardImport, useImportJob } from "./import/api";
import { RecentImports } from "./import/recent-imports";
import { ImportStepper } from "./import/stepper";
import { CheckStep } from "./import/step-check";
import { ImportStep } from "./import/step-import";
import { MapStep } from "./import/step-map";
import { UploadStep } from "./import/step-upload";
import type { ImportField, ImportJob, ImportMapping } from "./import/types";
import { canRedo, kindWords, stepFor, steps, type Step } from "./import/words";
import { StaffApiError } from "./queries/http";
import { useStaffAccess } from "./staff-access";

const stepTitles: Record<Step, string> = {
  upload: "Upload your file",
  map: "Match your columns",
  check: "Check your rows",
  import: "Import",
};

interface Setup { headers: string[]; fields: ImportField[]; suggestedMapping: ImportMapping }

export function ImportWorkspace() {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const access = useStaffAccess();
  const allowed = access.can("settings.manage");
  const [jobId, setJobId] = useQueryState("job", parseAsString);
  const [chosen, setChosen] = useState<Step | null>(null);
  const [conflict, setConflict] = useState(false);
  const live = catalog.database && allowed;
  const query = useImportJob(live ? jobId : null);
  const discard = useDiscardImport();
  const job: ImportJob | undefined = query.data?.job;

  const answer = query.data;
  const kept = jobId && answer ? recallSetup(jobId) : null;
  const setup: Setup | null = answer?.headers && answer.fields
    ? { headers: answer.headers, fields: answer.fields, suggestedMapping: answer.suggestedMapping ?? {} }
    : kept ? { headers: kept.headers, fields: kept.fields, suggestedMapping: kept.suggestedMapping } : null;
  const wanted: Step = !jobId ? "upload" : job ? chosen ?? stepFor(job.status) : "upload";
  // Matched columns whose names are gone (a reload in a new tab) can still be checked, just not re-matched.
  const step: Step = wanted === "map" && !setup && job?.status === "mapped" ? "check" : wanted;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const lastStep = useRef(step);
  useEffect(() => {
    // Move focus to the new step's heading, but not when the page first opens.
    if (lastStep.current !== step) headingRef.current?.focus();
    lastStep.current = step;
  }, [step]);


  function open(next: ImportJob | null) {
    setConflict(false);
    setChosen(null);
    void setJobId(next ? next.id : null);
  }

  async function discardCurrent() {
    if (!job) return;
    await discard.mutateAsync(job.id).catch(() => undefined);
    open(null);
  }

  const menu: ActionMenuEntry[] = [
    { kind: "label", id: "samples", label: "Sample files" },
    ...(["customers", "services", "appointments"] as const).map((kind) => ({ id: `sample-${kind}`, label: kindWords(kind, t).title, href: sampleUrl(kind), icon: <FileUp aria-hidden="true" /> })),
    ...(job && (canRedo(job.status) || job.status === "failed") ? [{ kind: "separator" as const, id: "sep" }, { id: "discard", label: "Discard this import", icon: <Trash2 aria-hidden="true" />, destructive: true, onSelect: () => void discardCurrent() }] : []),
  ];

  const page = {
      title: "Import data",
      description: `Bring in ${t.customers}, ${t.services} and ${t.appointments} from a spreadsheet.`,
      bar: [
        ...(jobId ? [{ id: "new", label: "New import", variant: "outline" as const, onSelect: () => open(null), pinned: true }] : []),
        { id: "settings", label: "Settings", href: "/settings", variant: "outline", priority: 1 },
      ] satisfies BarAction[],
      menu: live ? menu : undefined,
  };

  if (!allowed) {
    return (
      <WorkspacePage {...page}>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><LockKeyhole aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>You cannot import data</EmptyTitle>
            <EmptyDescription>Ask the {t.business} owner to give you access to settings.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </WorkspacePage>
    );
  }

  if (!catalog.database) {
    return (
      <WorkspacePage {...page}>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><FileUp aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>Importing is not available in the preview</EmptyTitle>
            <EmptyDescription>Imports are saved to the {t.business} database. Nothing is uploaded or stored in the preview.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </WorkspacePage>
    );
  }

  const gone = query.error instanceof StaffApiError && query.error.status === 404;
  const stepNumber = steps.indexOf(step) + 1;

  return (
    <WorkspacePage {...page}>
      <ImportStepper
        current={step}
        canGoTo={(target) => {
          if (target === "upload") return !isPolling(job?.status);
          if (!job) return false;
          if (target === "map") return canRedo(job.status) && setup !== null;
          if (target === "check") return job.status === "checked";
          return false;
        }}
        onGo={(target) => { if (target === "upload") open(null); else setChosen(target); }}
      />
      <h2 ref={headingRef} tabIndex={-1} className="font-heading text-base font-semibold outline-none">
        <span className="text-muted-foreground">Step {stepNumber} of {steps.length}: </span>{stepTitles[step]}
      </h2>

      {conflict ? (
        <Alert variant="warning" role="alert">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>This import was changed somewhere else, in another tab or by another person. Load the latest to carry on.</span>
            <Button size="sm" variant="outline" onClick={() => { setConflict(false); setChosen(null); void query.refetch(); }}><RefreshCw aria-hidden="true" /> Load the latest</Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {!jobId ? (
        <>
          <UploadStep onUploaded={(next) => open(next.job)} />
          <RecentImports activeId={null} onOpen={open} />
        </>
      ) : gone ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><FileUp aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>This import no longer exists</EmptyTitle>
            <EmptyDescription>It was discarded, or the link is old. You can start a new one.</EmptyDescription>
          </EmptyHeader>
          <Button onClick={() => open(null)}>Start a new import</Button>
        </Empty>
      ) : query.isError && !job ? (
        <div className="flex flex-col items-start gap-3">
          <Alert variant="error" role="alert"><TriangleAlert aria-hidden="true" /><AlertDescription>This import could not be loaded. {query.error.message}</AlertDescription></Alert>
          <Button variant="outline" onClick={() => void query.refetch()}>Try again</Button>
        </div>
      ) : !job ? (
        <div className="flex flex-col gap-3" role="status" aria-label="Loading this import"><Skeleton className="h-24 w-full" /><Skeleton className="h-48 w-full" /></div>
      ) : step === "map" && setup ? (
        <MapStep key={job.id} job={job} headers={setup.headers} fields={setup.fields} suggestedMapping={setup.suggestedMapping} onChecking={() => setChosen("check")} onConflict={() => setConflict(true)} />
      ) : step === "map" && job.status !== "mapped" ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><FileUp aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>Upload the file again to match its columns</EmptyTitle>
            <EmptyDescription>The column names are only kept while this browser tab stays open. Discard this import and upload the file once more.</EmptyDescription>
          </EmptyHeader>
          <Button onClick={() => void discardCurrent()} disabled={discard.isPending}>Discard and upload again</Button>
        </Empty>
      ) : step === "map" || step === "check" ? (
        <CheckStep
          job={job}
          fieldLabels={Object.fromEntries((setup?.fields ?? []).map((field) => [field.key, field.label]))}
          canChangeMapping={setup !== null}
          onBack={() => setChosen("map")}
          onContinue={() => setChosen("import")}
          onConflict={() => setConflict(true)}
        />
      ) : (
        <ImportStep job={job} onBackToCheck={() => setChosen("check")} onNewImport={() => open(null)} onConflict={() => setConflict(true)} />
      )}
    </WorkspacePage>
  );
}
