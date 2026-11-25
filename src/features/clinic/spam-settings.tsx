"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, ChevronDown, CircleCheck, ShieldAlert, Trash2, TriangleAlert } from "lucide-react";
import { useState, type FormEvent } from "react";

import { OptionSelect, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import {
  type BlocklistEntryView, type BlocklistKind, type BookingReportView, blocklistKinds, spamReasonCodes, spamReasonLabels,
} from "@/lib/spam-contact";

import { useCatalogLookups } from "./clinic-catalog";
import { staffMutation, staffQuery } from "./queries/http";

const keys = {
  reports: ["staff", "spam", "reports"] as const,
  blocklist: ["staff", "spam", "blocklist"] as const,
};

const kindLabels: Record<BlocklistKind, string> = { email: "Email address", phone: "Phone number", email_domain: "Whole email domain" };
const kindOptions = blocklistKinds.map((value) => ({ value, label: kindLabels[value] }));
const reasonOptions = spamReasonCodes.map((value) => ({ value, label: spamReasonLabels[value] }));

function whenText(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

function Loading({ label }: { label: string }) {
  return <div role="status" aria-label={label} className="flex flex-col gap-2"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>;
}

function LoadError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <Alert variant="error">
      <TriangleAlert aria-hidden="true" />
      <AlertDescription className="flex flex-wrap items-center gap-2">{message}<Button size="sm" variant="outline" onClick={retry}>Try again</Button></AlertDescription>
    </Alert>
  );
}

function ReportRow({ report, onDecide, pending }: { report: BookingReportView; onDecide: (decision: { decision: "ignore" } | { decision: "block"; kind: BlocklistKind }) => void; pending: boolean }) {
  const choices: { kind: BlocklistKind; label: string; hint: string | null }[] = [
    { kind: "email", label: "Block this email address", hint: report.emailHint },
    { kind: "phone", label: "Block this phone number", hint: report.phoneHint },
    { kind: "email_domain", label: "Block the whole email domain", hint: report.emailHint ? `@${report.emailHint.split("@")[1] ?? ""}` : null },
  ];
  const blockChoices = choices.filter((choice) => choice.hint);
  return (
    <li className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 font-medium text-sm"><span className="truncate">{report.emailHint ?? "No email"}</span><span className="text-muted-foreground tabular-nums">{report.phoneHint ?? ""}</span></p>
        <p className="text-muted-foreground text-xs">
          {spamReasonLabels[report.reasonCode]} · reported {whenText(report.createdAt)}{report.reportedByName ? ` by ${report.reportedByName}` : ""} · {report.bookingCount} {report.bookingCount === 1 ? "booking" : "bookings"} from this contact
        </p>
      </div>
      {report.status === "open" ? (
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" disabled={pending} onClick={() => onDecide({ decision: "ignore" })}>Ignore</Button>
          <Menu>
            <MenuTrigger render={<Button size="sm" variant="destructive-outline" disabled={pending} />}><Ban aria-hidden="true" /> Block <ChevronDown aria-hidden="true" /></MenuTrigger>
            <MenuPopup align="end">
              {blockChoices.map((choice) => <MenuItem key={choice.kind} onClick={() => onDecide({ decision: "block", kind: choice.kind })}>{choice.label} <span className="ms-auto ps-3 text-muted-foreground text-xs">{choice.hint}</span></MenuItem>)}
            </MenuPopup>
          </Menu>
        </div>
      ) : <Badge variant={report.status === "blocked" ? "error" : "outline"}>{report.status === "blocked" ? "Blocked" : "Ignored"}</Badge>}
    </li>
  );
}

function ReviewQueue() {
  const client = useQueryClient();
  const open = useQuery({ queryKey: [...keys.reports, "open"], queryFn: ({ signal }) => staffQuery<{ reports: BookingReportView[] }>("/api/staff/booking-reports?status=open", signal) });
  const decided = useQuery({ queryKey: [...keys.reports, "decided"], queryFn: ({ signal }) => staffQuery<{ reports: BookingReportView[] }>("/api/staff/booking-reports?status=decided", signal) });
  const [error, setError] = useState("");
  const decide = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { decision: "ignore" } | { decision: "block"; kind: BlocklistKind } }) => staffMutation<{ status: string }>(`/api/staff/booking-reports/${id}`, "PATCH", body),
    onSuccess: async (result) => {
      setError("");
      toastManager.add({ title: result.status === "blocked" ? "Blocked. New bookings from them will look normal to them but be discarded." : "Report closed.", type: "success" });
      await client.invalidateQueries({ queryKey: ["staff", "spam"] });
    },
    onError: (cause: unknown) => setError(cause instanceof Error ? cause.message : "That could not be saved. Try again."),
  });
  const reports = open.data?.reports ?? [];
  return (
    <div className="flex flex-col gap-4">
      {error ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
      {open.isPending ? <Loading label="Loading reports" /> : null}
      {open.isError ? <LoadError message="The reports could not be loaded." retry={() => void open.refetch()} /> : null}
      {open.data && reports.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><CircleCheck aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>Nothing to review</EmptyTitle>
            <EmptyDescription>When someone reports a booking as spam from its ⋯ menu, it waits here for you to ignore or block.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {reports.length > 0 ? <ul className="flex flex-col gap-2" aria-label="Open spam reports">{reports.map((report) => <ReportRow key={report.id} report={report} pending={decide.isPending} onDecide={(body) => decide.mutate({ id: report.id, body })} />)}</ul> : null}
      {(decided.data?.reports.length ?? 0) > 0 ? (
        <section aria-label="Decided reports" className="flex flex-col gap-2">
          <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">Decided</h4>
          <ul className="flex flex-col gap-2">{decided.data?.reports.slice(0, 10).map((report) => <ReportRow key={report.id} report={report} pending onDecide={() => undefined} />)}</ul>
        </section>
      ) : null}
    </div>
  );
}

function Blocklist() {
  const client = useQueryClient();
  const list = useQuery({ queryKey: keys.blocklist, queryFn: ({ signal }) => staffQuery<{ entries: BlocklistEntryView[] }>("/api/staff/blocklist", signal) });
  const [kind, setKind] = useState<BlocklistKind>("email");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("other");
  const [fieldError, setFieldError] = useState("");
  const [error, setError] = useState("");
  const refresh = () => client.invalidateQueries({ queryKey: ["staff", "spam"] });
  const add = useMutation({
    mutationFn: () => staffMutation<{ id: string }>("/api/staff/blocklist", "POST", { kind, value: value.trim(), reasonCode: reason }),
    onSuccess: async () => { setValue(""); setFieldError(""); setError(""); toastManager.add({ title: "Added to the blocklist.", type: "success" }); await refresh(); },
    onError: (cause: unknown) => {
      const message = cause instanceof Error ? cause.message : "That could not be added. Try again.";
      if (cause instanceof Error && "code" in cause && (cause.code === "validation_error" || cause.code === "domain_too_broad")) setFieldError(message); else setError(message);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => staffMutation<{ removed: true }>(`/api/staff/blocklist/${id}`, "DELETE", {}),
    onSuccess: async () => { toastManager.add({ title: "Removed. Bookings already cancelled stay cancelled.", type: "success" }); await refresh(); },
    onError: (cause: unknown) => setError(cause instanceof Error ? cause.message : "That could not be removed. Try again."),
  });
  function submit(event: FormEvent) { event.preventDefault(); setFieldError(""); if (value.trim().length >= 3) add.mutate(); else setFieldError("Enter the value to block."); }
  const entries = list.data?.entries ?? [];
  return (
    <div className="flex flex-col gap-4">
      {error ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[11rem_1fr_10rem_auto] sm:items-end" aria-label="Add to the blocklist">
        <div className="flex flex-col gap-1.5"><span className="font-medium text-sm">What to block</span><OptionSelect aria-label="What to block" value={kind} onValueChange={(next) => setKind(blocklistKinds.find((item) => item === next) ?? "email")} options={kindOptions} /></div>
        <TextField label="Value" value={value} onChange={(event) => setValue(event.target.value)} error={fieldError} placeholder={kind === "phone" ? "+91 98765 43210" : kind === "email_domain" ? "example.com" : "name@example.com"} autoComplete="off" />
        <div className="flex flex-col gap-1.5"><span className="font-medium text-sm">Why</span><OptionSelect aria-label="Why" value={reason} onValueChange={setReason} options={reasonOptions} /></div>
        <Button type="submit" loading={add.isPending} className="sm:mb-px">Block</Button>
      </form>
      {list.isPending ? <Loading label="Loading the blocklist" /> : null}
      {list.isError ? <LoadError message="The blocklist could not be loaded." retry={() => void list.refetch()} /> : null}
      {list.data && entries.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Ban aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>No one is blocked</EmptyTitle>
            <EmptyDescription>Blocked contacts are stored as scrambled codes with a short hint like r•••@gmail.com.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {entries.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="Blocked contacts">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-center gap-3 rounded-lg border p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-sm">{entry.hint} <span className="font-normal text-muted-foreground">· {kindLabels[entry.kind]}</span></p>
                <p className="text-muted-foreground text-xs">{spamReasonLabels[entry.reasonCode]} · added {whenText(entry.createdAt)}{entry.addedByName ? ` by ${entry.addedByName}` : ""}</p>
              </div>
              <Button size="icon-sm" variant="ghost" aria-label={`Remove ${entry.hint} from the blocklist`} disabled={remove.isPending} onClick={() => remove.mutate(entry.id)}><Trash2 aria-hidden="true" /></Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The Spam page: the review queue of reported bookings and the blocklist (feature 44). */
export function SpamSettings() {
  const t = useTerms();
  const database = useCatalogLookups().database;
  if (!database) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><ShieldAlert aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>Spam protection is not available in the preview</EmptyTitle>
          <EmptyDescription>Reports and the blocklist are saved on the {t.business} database.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>Spam</FrameTitle>
        <FrameDescription>A blocked person still sees a normal confirmation, but nothing is booked, held or sent, so they never learn they were blocked.</FrameDescription>
      </FrameHeader>
      <FramePanel>
        <Tabs defaultValue="review">
          <TabsList variant="underline"><TabsTab value="review">Review</TabsTab><TabsTab value="blocklist">Blocklist</TabsTab></TabsList>
          <TabsPanel value="review" className="pt-3"><ReviewQueue /></TabsPanel>
          <TabsPanel value="blocklist" className="pt-3"><Blocklist /></TabsPanel>
        </Tabs>
      </FramePanel>
    </Frame>
  );
}
