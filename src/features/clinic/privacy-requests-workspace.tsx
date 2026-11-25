"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Clock3, Inbox, LockKeyhole, TriangleAlert } from "lucide-react";

import { SelectField, TextareaField } from "@/components/form-fields";
import { WorkspacePage } from "@/components/workspace-page";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameHeader, FramePanel } from "@/components/ui/frame";
import { ResponsiveDrawer, ResponsiveDrawerPopup } from "@/components/responsive-drawer";
import { DrawerDescription, DrawerFooter, DrawerHeader, DrawerPanel, DrawerTitle } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { refusalReasons, type DataRequestType, type DecisionReason } from "@/server/privacy/rules";

import { useCatalogLookups } from "./clinic-catalog";
import { StaffApiError } from "./queries/http";
import { decideRequestCall, usePrivacyRequests, type RequestStatusFilter, type RequestTypeFilter, type StaffRequestView } from "./queries/privacy";
import { useStaffAccess } from "./staff-access";
import { useStepUp } from "./step-up-dialog";

const typeLabels: Record<DataRequestType, string> = {
  export: "Download of their data",
  erasure: "Delete their data",
  correction: "Correction",
};

/** What a person picks when refusing. Typed over every reason, so a new one in the backend fails typecheck here. */
const reasonLabels: Record<DecisionReason, string> = {
  verified: "We checked it is them",
  legal_retention: "We must keep this information",
  identity_not_confirmed: "We could not confirm who they are",
  not_this_business: "We hold nothing about them",
  duplicate: "They already asked",
  unreasonable: "We cannot act on this request",
  other: "Another reason (add a note)",
};

const statusFilters: { value: RequestStatusFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "overdue", label: "Overdue" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

const typeFilters: { value: RequestTypeFilter; label: string }[] = [
  { value: "all", label: "All kinds" },
  { value: "export", label: "Downloads" },
  { value: "erasure", label: "Deletions" },
  { value: "correction", label: "Corrections" },
];

const dayFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const day = (iso: string) => dayFormat.format(new Date(iso));

const statusText: Record<StaffRequestView["status"], string> = {
  requested: "Needs a decision",
  approved: "Approved",
  processing: "Being processed",
  completed: "Done",
  refused: "Refused",
  failed: "Failed",
};

function statusTone(status: StaffRequestView["status"]): "success" | "attention" | "neutral" | "danger" | "info" {
  switch (status) {
    case "requested": return "attention";
    case "approved":
    case "processing": return "info";
    case "completed": return "success";
    case "failed": return "danger";
    case "refused": return "neutral";
  }
}

/** "41 days left", "Due today", "Overdue by 3 days": always words, never colour alone. */
export function dueText(request: Pick<StaffRequestView, "daysRemaining" | "overdue" | "dueAt">): string {
  const days = request.daysRemaining;
  if (days === null) return `Was due ${day(request.dueAt)}`;
  if (request.overdue || days < 0) {
    const late = Math.max(1, Math.abs(days));
    return `Overdue by ${late} ${late === 1 ? "day" : "days"}`;
  }
  if (days === 0) return "Due today";
  return `${days} ${days === 1 ? "day" : "days"} left`;
}

function DueCell({ request }: { request: StaffRequestView }) {
  const late = request.overdue && request.daysRemaining !== null;
  return (
    <span className={late ? "inline-flex items-center gap-1 font-medium text-destructive-foreground" : "inline-flex items-center gap-1"}>
      {late ? <TriangleAlert aria-hidden="true" className="size-4 shrink-0" /> : <Clock3 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
      {dueText(request)}
    </span>
  );
}

export function PrivacyRequestsWorkspace() {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const access = useStaffAccess();
  const allowed = access.can("privacy.manage");
  const live = Boolean(catalog.database) && allowed;
  const [status, setStatus] = useState<RequestStatusFilter>("open");
  const [type, setType] = useState<RequestTypeFilter>("all");
  const [selected, setSelected] = useState<StaffRequestView | null>(null);
  const query = usePrivacyRequests(status, type, live);
  const requests = query.data?.requests ?? [];
  const counts = query.data?.counts;

  return (
    <WorkspacePage
      title="Privacy requests"
      description={`What ${t.customers} have asked about their information. Each is due within 90 days.`}
      bar={[{ id: "settings", label: "Settings", href: "/settings", variant: "outline", pinned: true }]}
    >
      {!allowed ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><LockKeyhole aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>You cannot handle privacy requests</EmptyTitle>
            <EmptyDescription>Ask the {t.business} owner to switch on &quot;Handle privacy requests&quot; for you under Sign-in and access on the Team page.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : !catalog.database ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Inbox aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>Privacy requests are not available in the preview</EmptyTitle>
            <EmptyDescription>They come from {t.customers} on the {t.business} database. Nothing is stored in the preview.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Frame>
          <FrameHeader className="flex-row flex-wrap items-end justify-between gap-3">
            <div className="flex min-w-0 flex-1 basis-64 flex-wrap gap-3">
              <SelectField label="Show" fieldClassName="w-40" value={status} onValueChange={(value) => setStatus(value as RequestStatusFilter)} options={statusFilters} />
              <SelectField label="Kind" fieldClassName="w-44" value={type} onValueChange={(value) => setType(value as RequestTypeFilter)} options={typeFilters} />
            </div>
            {counts ? (
              <p className="text-sm text-muted-foreground" role="status">
                {counts.open} open{counts.overdue ? <>, <span className="font-medium text-destructive-foreground">{counts.overdue} overdue</span></> : null}
              </p>
            ) : null}
          </FrameHeader>
          <FramePanel className="p-0">
            {query.isPending ? (
              <div role="status" aria-label="Loading privacy requests" className="flex flex-col gap-3 p-4">
                {[0, 1, 2].map((row) => <Skeleton key={row} className="h-12 w-full" />)}
              </div>
            ) : query.isError ? (
              <div className="p-4">
                <Alert variant="error">
                  <TriangleAlert aria-hidden="true" />
                  <AlertTitle>The requests could not be loaded</AlertTitle>
                  <AlertDescription>
                    <p>{query.error instanceof Error ? query.error.message : "Try again in a moment."}</p>
                    <Button variant="outline" size="sm" className="self-start" onClick={() => void query.refetch()}>Try again</Button>
                  </AlertDescription>
                </Alert>
              </div>
            ) : requests.length === 0 ? (
              <Empty className="py-10">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Inbox aria-hidden="true" /></EmptyMedia>
                  <EmptyTitle>{status === "overdue" ? "Nothing is overdue" : "No requests here"}</EmptyTitle>
                  <EmptyDescription>When a {t.customer} asks for a copy of their data, a correction or a deletion, it shows here.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table aria-label="Privacy requests">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.Customer}</TableHead>
                    <TableHead className="max-sm:hidden">Kind</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead><span className="sr-only">Action</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requests.map((request) => (
                    <TableRow key={request.id}>
                      <TableCell className="whitespace-normal">
                        <p className="font-medium">{request.customerName}</p>
                        <p className="text-xs text-muted-foreground sm:hidden">{typeLabels[request.type]}</p>
                        <StatusBadge tone={statusTone(request.status)} className="mt-1 sm:hidden">{statusText[request.status]}</StatusBadge>
                        <p className="mt-1 text-xs text-muted-foreground">Asked {day(request.createdAt)}</p>
                      </TableCell>
                      <TableCell className="max-sm:hidden">
                        <p>{typeLabels[request.type]}</p>
                        <StatusBadge tone={statusTone(request.status)} className="mt-1">{statusText[request.status]}</StatusBadge>
                      </TableCell>
                      <TableCell className="whitespace-normal text-sm"><DueCell request={request} /></TableCell>
                      <TableCell className="text-end">
                        <Button variant="outline" size="sm" onClick={() => setSelected(request)}>
                          Review request<span className="sr-only"> from {request.customerName}</span>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </FramePanel>
        </Frame>
      )}
      <ResponsiveDrawer open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <ResponsiveDrawerPopup variant="inset" className="sm:max-w-[30rem]">
          {selected ? <ReviewPanel key={selected.id} request={selected} onClose={() => setSelected(null)} /> : null}
        </ResponsiveDrawerPopup>
      </ResponsiveDrawer>
    </WorkspacePage>
  );
}

function ReviewPanel({ request, onClose }: { request: StaffRequestView; onClose: () => void }) {
  const t = useTerms();
  const queryClient = useQueryClient();
  const { runWithStepUp } = useStepUp();
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<"approve" | "refuse" | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState<StaffRequestView | null>(null);
  const current = done ?? request;
  const decidable = current.status === "requested";

  async function decide(decision: "approve" | "refuse") {
    if (decision === "refuse" && !reason) {
      setError("Choose a reason before you refuse.");
      return;
    }
    setPending(decision);
    setError("");
    // One key per click: a retry after the code check repeats the same decision.
    const key = crypto.randomUUID();
    const body = { decision, reason: decision === "approve" ? "verified" : reason, ...(note.trim() ? { note: note.trim() } : {}), version: request.version };
    try {
      const result = await runWithStepUp(() => decideRequestCall(request.id, body, key));
      setDone(result);
      await queryClient.invalidateQueries({ queryKey: ["staff", "privacy"] });
      toastManager.add({
        title: decision === "refuse" ? "Request refused" : request.type === "erasure" ? "Deletion queued" : "Request approved",
        type: "success",
      });
    } catch (cause: unknown) {
      const code = cause instanceof StaffApiError ? cause.code : "";
      if (code === "version_conflict" || code === "already_decided") {
        await queryClient.invalidateQueries({ queryKey: ["staff", "privacy"] });
        setError("Someone else already dealt with this request. The list is updated.");
      } else if (code === "step_up_required" || code === "second_factor_required") {
        setError("A fresh code is needed for this. Try again and enter your code.");
      } else {
        setError(cause instanceof Error ? cause.message : "The decision could not be saved.");
      }
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{typeLabels[request.type]}</DrawerTitle>
        <DrawerDescription>From {request.customerName}. Asked {day(request.createdAt)}, via {request.requestedVia}.</DrawerDescription>
      </DrawerHeader>
      <DrawerPanel className="flex flex-col gap-4">
        <dl className="flex flex-col divide-y text-sm">
          <div className="flex flex-wrap justify-between gap-2 pb-2.5">
            <dt className="text-muted-foreground">Status</dt>
            <dd><StatusBadge tone={statusTone(current.status)}>{statusText[current.status]}</StatusBadge></dd>
          </div>
          <div className="flex flex-wrap justify-between gap-2 py-2.5">
            <dt className="text-muted-foreground">Due</dt>
            <dd className="font-medium"><DueCell request={current} /></dd>
          </div>
          {request.note ? (
            <div className="flex flex-col gap-1 pt-2.5">
              <dt className="text-muted-foreground">What the {t.customer} wrote</dt>
              <dd className="whitespace-pre-wrap">{request.note}</dd>
            </div>
          ) : null}
        </dl>

        {error ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}

        {done ? <Outcome request={done} /> : null}

        {decidable && !done ? (
          <>
            <Alert variant="info" role="note">
              <AlertDescription>
                {request.type === "erasure"
                  ? `Approving removes their details after a check of your code. Payments and records you must keep stay, and the ${t.customer} is told which.`
                  : request.type === "correction"
                    ? `Approving marks it done. Make the change on the ${t.customer}'s record yourself.`
                    : "Downloads are approved for you, so you should not see this here."}
              </AlertDescription>
            </Alert>
            <SelectField
              label="Reason"
              hint="Needed to refuse. The reason goes to the person who asked."
              value={reason}
              onValueChange={(value) => { setReason(value); setError(""); }}
              options={refusalReasons.map((value) => ({ value, label: reasonLabels[value] }))}
              placeholder="Choose a reason"
            />
            <TextareaField label="Note for the person who asked" optional maxLength={500} rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
          </>
        ) : null}
        {!decidable && !done ? (
          <p className="text-sm text-muted-foreground">
            {current.decisionReason ? `${reasonLabels[current.decisionReason]}.` : "No decision is needed."}
            {current.decisionNote ? ` ${current.decisionNote}` : ""}
            {current.summary ? ` ${current.summary.removed.length} kinds of detail removed, ${current.summary.kept.length} kept.` : ""}
          </p>
        ) : null}
      </DrawerPanel>
      <DrawerFooter className="flex-row flex-nowrap justify-end">
        <Button variant="ghost" onClick={onClose}>{done || !decidable ? "Close" : "Cancel"}</Button>
        {decidable && !done ? (
          <>
            <Button variant="outline" onClick={() => void decide("refuse")} disabled={pending !== null}>
              {pending === "refuse" ? <Spinner aria-hidden="true" /> : null}Refuse
            </Button>
            <Button onClick={() => void decide("approve")} disabled={pending !== null}>
              {pending === "approve" ? <Spinner aria-hidden="true" /> : null}Approve
            </Button>
          </>
        ) : null}
      </DrawerFooter>
    </>
  );
}

function Outcome({ request }: { request: StaffRequestView }) {
  const t = useTerms();
  const text = request.status === "refused"
    ? `Refused. The ${t.customer} will see your reason.`
    : request.type === "erasure"
      ? `Queued. We will remove their details shortly, then email the ${t.customer} what was removed and what was kept.`
      : `Done. Now make the change on the ${t.customer}'s record.`;
  return (
    <Alert variant="success" role="status">
      <CircleCheck aria-hidden="true" />
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}
