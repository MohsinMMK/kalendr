"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { CheckCircle2, Copy, Globe2, MoreHorizontal, RefreshCw, RotateCcw, Trash2, TriangleAlert } from "lucide-react";

import { ActionMenuButton } from "@/components/action-bar";
import { TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { useUpgradePrompt } from "@/features/billing/upgrade-prompt";
import { useTerms } from "@/features/terms/business-profile-context";
import { checkResultText, pendingWindowHours, type DomainCheckResult, type DomainState } from "@/lib/domain-rules";

import { ConfirmDialog } from "./calendar-confirm";
import { useCatalogLookups } from "./clinic-catalog";
import { identityKeys, useDomains, type CreatedDomain, type DomainOverview } from "./queries/identity";
import { StaffApiError, staffMutation } from "./queries/http";
import { useStaffAccess } from "./staff-access";

type StaffDomain = DomainOverview["domains"][number];

const stateBadge: Record<DomainState, { label: string; variant: "success" | "warning" | "error" | "outline" }> = {
  pending: { label: "Waiting for records", variant: "outline" },
  live: { label: "Live", variant: "success" },
  warning: { label: "Records missing", variant: "warning" },
  failed: { label: "Not connected", variant: "error" },
};

function describeResult(result: string | null): string {
  return result && result in checkResultText ? checkResultText[result as DomainCheckResult] : "";
}

function when(value: string | null): string {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "";
}

function RecordRow({ type, name, value, note }: { type: string; name: string; value: string | null; note?: string }) {
  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toastManager.add({ title: `${label} copied`, type: "success" });
    } catch {
      toastManager.add({ title: "Copy failed", description: "Select the text and copy it by hand.", type: "error" });
    }
  }
  return (
    <div className="grid gap-1 rounded-lg border p-3 text-sm sm:grid-cols-[4rem_minmax(0,1fr)] sm:gap-3">
      <p className="font-mono font-semibold text-xs">{type}</p>
      <dl className="grid min-w-0 gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0"><dt className="text-muted-foreground text-xs">Name</dt><dd className="font-mono text-xs [overflow-wrap:anywhere]">{name}</dd></div>
          <Button size="icon-sm" variant="ghost" aria-label={`Copy the ${type} name`} onClick={() => void copy(name, "Name")}><Copy aria-hidden="true" /></Button>
        </div>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0"><dt className="text-muted-foreground text-xs">Value</dt><dd className="font-mono text-xs [overflow-wrap:anywhere]">{value ?? "Shown when you ask for the records again"}</dd></div>
          {value ? <Button size="icon-sm" variant="ghost" aria-label={`Copy the ${type} value`} onClick={() => void copy(value, "Value")}><Copy aria-hidden="true" /></Button> : null}
        </div>
        {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
      </dl>
    </div>
  );
}

function DomainCard({ domain, target, txtValue, canChange, onChanged, onToken }: {
  domain: StaffDomain;
  target: string;
  /** The TXT value, only while it is still on screen from when it was made. */
  txtValue: string | null;
  canChange: boolean;
  onChanged: () => Promise<unknown>;
  onToken: (created: CreatedDomain) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const badge = stateBadge[domain.state];
  const pending = domain.state === "pending";

  async function checkNow() {
    setChecking(true);
    try {
      await staffMutation(`/api/staff/domains/${domain.id}/verify`, "POST", {});
      toastManager.add({ title: "Checking your records", description: "This usually takes under a minute.", type: "info" });
      await onChanged();
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not start the check", description: cause instanceof Error ? cause.message : "Try again.", type: "error" });
    } finally {
      // The worker answers on its own time; keep the button quiet briefly so it is not pressed twice in a row.
      setTimeout(() => setChecking(false), 4_000);
    }
  }
  async function showAgain() {
    try {
      onToken(await staffMutation<CreatedDomain>(`/api/staff/domains/${domain.id}/token`, "POST", {}));
      await onChanged();
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not make new records", description: cause instanceof Error ? cause.message : "Try again.", type: "error" });
    }
  }
  async function remove() {
    setRemoving(true);
    try {
      await staffMutation(`/api/staff/domains/${domain.id}`, "DELETE", {});
      await onChanged();
      setConfirmRemove(false);
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not remove the address", description: cause instanceof Error ? cause.message : "Try again.", type: "error" });
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Frame>
      <FrameHeader className="flex-row items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <FrameTitle className="truncate font-mono text-sm">{domain.hostname}</FrameTitle>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {pending ? <Button size="sm" variant="outline" disabled={!canChange || checking} loading={checking} onClick={() => void checkNow()}><RefreshCw aria-hidden="true" />Check now</Button> : null}
          <ActionMenuButton
            iconOnly
            label="More actions for this address"
            icon={<MoreHorizontal aria-hidden="true" />}
            variant="ghost"
            disabled={!canChange}
            items={[
              ...(domain.state === "live" || domain.state === "warning" ? [{ id: "check", label: "Check now", icon: <RefreshCw aria-hidden="true" />, onSelect: () => void checkNow() }] : []),
              ...(domain.state !== "live" && domain.state !== "warning" ? [{ id: "again", label: "Show the records again", hint: "Makes a new TXT value and starts another 3 days", icon: <RotateCcw aria-hidden="true" />, onSelect: () => void showAgain() }] : []),
              { id: "remove", label: "Remove this address", icon: <Trash2 aria-hidden="true" />, destructive: true, onSelect: () => setConfirmRemove(true) },
            ]}
          />
        </div>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-3">
        {domain.state === "live" ? (
          <p className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4 text-success" aria-hidden="true" />Your booking page is live at <a className="font-medium underline underline-offset-2" href={`https://${domain.hostname}`} target="_blank" rel="noopener noreferrer">https://{domain.hostname}</a>.</p>
        ) : null}
        {domain.state === "warning" ? (
          <Alert variant="warning">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>We can’t find the records any more (since {when(domain.missingSince)}). Put them back within 7 days or the address stops showing your booking page.</AlertDescription>
          </Alert>
        ) : null}
        {domain.state === "failed" ? (
          <Alert variant="error">
            <AlertDescription>We could not connect this address. Check the records below with your domain provider, then choose “Show the records again” to try for another {pendingWindowHours / 24} days.</AlertDescription>
          </Alert>
        ) : null}

        {domain.state !== "live" ? (
          <ol className="flex flex-col gap-3 text-sm">
            <li className="flex flex-col gap-2">
              <p className="font-medium">Step 2. Add these two records where you manage {domain.hostname.split(".").slice(1).join(".")}</p>
              <RecordRow type="CNAME" name={domain.records.cname.name} value={target} />
              <RecordRow type="TXT" name={domain.records.txt.name} value={txtValue} note="Proves the address is yours." />
            </li>
            <li>
              <p className="font-medium">Step 3. Check</p>
              <p className="text-muted-foreground text-xs">
                {pending ? `We check every few minutes for ${pendingWindowHours} hours, or press Check now. ` : ""}
                {domain.lastCheckedAt ? `Last looked ${when(domain.lastCheckedAt)}. ${describeResult(domain.lastResult)}` : "Not checked yet."}
              </p>
            </li>
            <li><p className="font-medium">Step 4. Done</p><p className="text-muted-foreground text-xs">When both records are found the address goes live by itself, with its own certificate.</p></li>
          </ol>
        ) : domain.lastCheckedAt ? <p className="text-muted-foreground text-xs">Records last confirmed {when(domain.lastCheckedAt)}. We check once a day.</p> : null}
      </FramePanel>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${domain.hostname}?`}
        description="The address stops showing your booking page straight away. Your Kalendr link keeps working."
        confirmLabel="Remove address"
        destructive
        busy={removing}
        onConfirm={() => void remove()}
      />
    </Frame>
  );
}

/**
 * Own web address (feature 13), in four plain steps: type the address, add two DNS records, check, done. The check
 * runs in the background, so this screen reads the list again every few seconds while an address is waiting.
 */
export function DomainSettingsPanel() {
  const t = useTerms();
  const database = useCatalogLookups().database;
  const canChange = useStaffAccess().can("settings.manage");
  const upgrade = useUpgradePrompt();
  const queryClient = useQueryClient();
  const [hostname, setHostname] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [adding, setAdding] = useState(false);
  // TXT values made in this visit, by address id. Only the hash is stored, so a value cannot be read back later.
  const [values, setValues] = useState<Record<string, string>>({});
  const domains = useDomains(database);

  if (!database) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><Globe2 aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>Own web addresses are not available in the preview</EmptyTitle>
          <EmptyDescription>They are saved on the {t.business} database. Start the local database to connect one.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (domains.isPending) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (domains.isError) {
    return (
      <Alert variant="error">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">{domains.error.message}<Button size="sm" variant="outline" onClick={() => void domains.refetch()}>Try again</Button></AlertDescription>
      </Alert>
    );
  }
  const overview = domains.data;
  const refresh = () => queryClient.invalidateQueries({ queryKey: identityKeys.domains() });

  async function add(event: FormEvent) {
    event.preventDefault();
    setFieldError("");
    setAdding(true);
    try {
      const created = await staffMutation<CreatedDomain>("/api/staff/domains", "POST", { hostname });
      setValues((current) => ({ ...current, [created.domain.id]: created.txtValue }));
      setHostname("");
      await refresh();
    } catch (cause: unknown) {
      if (upgrade.fromError(cause)) return;
      if (cause instanceof StaffApiError && cause.fieldErrors.hostname?.[0]) setFieldError(cause.fieldErrors.hostname[0]);
      else toastManager.add({ title: "Could not add the address", description: cause instanceof Error ? cause.message : "Try again.", type: "error" });
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!overview.configured ? (
        <Alert variant="info">
          <AlertDescription>Own web addresses are not set up on this Kalendr yet. The person who runs it needs to set the CNAME target first.</AlertDescription>
        </Alert>
      ) : null}
      <Frame>
        <FrameHeader>
          <FrameTitle>Your own web address</FrameTitle>
          <FrameDescription>Let {t.customers} book at an address like book.yourbusiness.com, in your colours. Step 1: type the address.</FrameDescription>
        </FrameHeader>
        <FramePanel>
          <form className="flex flex-col gap-3 sm:flex-row sm:items-start" onSubmit={(event) => void add(event)} noValidate>
            <TextField
              label="Address"
              value={hostname}
              onChange={(event) => { setHostname(event.target.value); setFieldError(""); }}
              placeholder="book.yourbusiness.com"
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              disabled={!canChange || !overview.configured}
              error={fieldError}
              hint="Use a name in front of your domain, like book or appointments."
              fieldClassName="sm:flex-1"
            />
            <Button type="submit" size="lg" className="sm:mt-[1.625rem]" loading={adding} disabled={!canChange || !overview.configured || hostname.trim().length < 3}>Add address</Button>
          </form>
        </FramePanel>
      </Frame>
      {overview.domains.length === 0 ? (
        <p className="text-muted-foreground text-sm">No address connected yet. Your Kalendr link keeps working either way.</p>
      ) : overview.domains.map((domain) => (
        <DomainCard
          key={domain.id}
          domain={domain}
          target={overview.cnameTarget ?? ""}
          txtValue={values[domain.id] ?? null}
          canChange={canChange}
          onChanged={refresh}
          onToken={(created) => setValues((current) => ({ ...current, [created.domain.id]: created.txtValue }))}
        />
      ))}
    </div>
  );
}
