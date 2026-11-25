"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useState } from "react";

import { TextareaField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { UNDO_WINDOW_DAYS, type DuplicateSide, type MergeResult } from "@/lib/customer-contracts";

import { dayLabel, errorText, isStepUpDeclined, LoadFailed } from "./customer-parts";
import { staffMutation } from "./queries/http";
import { customerKeys } from "./queries/customers";
import { usePatientSearch } from "./queries/patient-search";
import { staffKeys } from "./queries/keys";
import { useStepUp } from "./step-up-dialog";

/** After any change to a customer: what the profile shows, the customer list and the open segments are all stale. */
export function useCustomerChanged() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: customerKeys.all() });
    void client.invalidateQueries({ queryKey: customerKeys.segments() });
    void client.invalidateQueries({ queryKey: customerKeys.duplicates() });
    void client.invalidateQueries({ queryKey: staffKeys.snapshot() });
    void client.invalidateQueries({ queryKey: staffKeys.patients() });
  };
}

/** A required reason, kept on the profile for the team. It is never copied into the activity log. */
export function BlockDialog({ patientId, name, open, onOpenChange }: { patientId: string; name: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTerms();
  const changed = useCustomerChanged();
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(""); setMessage("");
    if (reason.trim().length < 3) { setError("Say why, so the team knows."); return; }
    setBusy(true);
    try {
      await staffMutation(`/api/staff/customers/${encodeURIComponent(patientId)}/block`, "POST", { reason: reason.trim() });
      changed();
      toastManager.add({ title: `${name} is blocked from booking online`, type: "success" });
      setReason("");
      onOpenChange(false);
    } catch (cause: unknown) {
      setMessage(errorText(cause, "That could not be saved. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form noValidate aria-label={`Block ${name}`} className="contents" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Block {name} from booking online?</DialogTitle>
            <DialogDescription>Their booking page will say &ldquo;please call us&rdquo;. Your team can still book them at the desk, and everyone will see a warning on their profile.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
            <TextareaField label={`Why are you blocking this ${t.customer}?`} hint="Your team sees this. Keep it factual." value={reason} onChange={(event) => setReason(event.target.value)} error={error} maxLength={200} rows={3} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="destructive" disabled={busy}>{busy ? <Spinner /> : null}Block</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function useUnblock(patientId: string, name: string) {
  const changed = useCustomerChanged();
  return async () => {
    try {
      await staffMutation(`/api/staff/customers/${encodeURIComponent(patientId)}/block`, "DELETE", {});
      changed();
      toastManager.add({ title: `${name} can book online again`, type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not unblock", description: errorText(cause, "Try again."), type: "error" });
    }
  };
}

export function useUndoMerge() {
  const changed = useCustomerChanged();
  const { runWithStepUp } = useStepUp();
  return async (mergeId: string) => {
    try {
      await runWithStepUp(() => staffMutation(`/api/staff/customers/merge/${encodeURIComponent(mergeId)}`, "DELETE", {}));
      changed();
      toastManager.add({ title: "Merge undone", description: "Both profiles are back as they were.", type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: isStepUpDeclined(cause) ? "A code from your authenticator app is needed to undo a merge." : "Could not undo the merge", description: isStepUpDeclined(cause) ? undefined : errorText(cause, "Try again."), type: "error" });
    }
  };
}

function SideSummary({ side, keep }: { side: DuplicateSide; keep: boolean }) {
  return (
    <div className={`min-w-0 flex-1 rounded-lg border p-3 text-sm ${keep ? "border-primary bg-primary/4" : ""}`}>
      <p className="truncate font-medium">{side.name}</p>
      <p className="truncate text-muted-foreground tabular-nums">{side.phone || "No phone"}</p>
      <p className="truncate text-muted-foreground">{side.email || "No email"}</p>
      <p className="mt-1 text-muted-foreground text-xs">{side.visits} {side.visits === 1 ? "visit" : "visits"}{side.lastVisitAt ? `, last on ${dayLabel(side.lastVisitAt)}` : ""}</p>
    </div>
  );
}

/**
 * Two profiles of one person, side by side. The person chooses which one stays; everything moves to it in one step,
 * and it can be undone for 30 days. It asks for a second-factor code first.
 */
export function MergeDialog({ pair, open, onOpenChange, onMerged }: { pair: { a: DuplicateSide; b: DuplicateSide; reasons?: string[] } | null; open: boolean; onOpenChange: (open: boolean) => void; onMerged?: (result: MergeResult) => void }) {
  const t = useTerms();
  const changed = useCustomerChanged();
  const { runWithStepUp } = useStepUp();
  const [keepId, setKeepId] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  if (!pair) return null;
  const chosen = keepId === pair.b.id ? pair.b : pair.a;
  const other = chosen.id === pair.a.id ? pair.b : pair.a;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!pair) return;
    setMessage(""); setBusy(true);
    try {
      const result = await runWithStepUp(() => staffMutation<MergeResult>("/api/staff/customers/merge", "POST", { keepId: chosen.id, mergeId: other.id }, { idempotencyKey: key }));
      setKey(crypto.randomUUID());
      changed();
      toastManager.add({ title: "Profiles merged", description: `You can undo this until ${dayLabel(result.undoUntil)}.`, type: "success" });
      onMerged?.(result);
      onOpenChange(false);
    } catch (cause: unknown) {
      setKey(crypto.randomUUID());
      setMessage(isStepUpDeclined(cause) ? "A code from your authenticator app is needed to merge profiles." : errorText(cause, "The profiles could not be merged. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form noValidate aria-label={`Merge ${t.customers}`} className="contents" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Merge two profiles</DialogTitle>
            <DialogDescription>{pair.reasons?.length ? `${pair.reasons.join(". ")}. ` : ""}Choose the profile to keep. Its name and contact details stay; the other profile&rsquo;s {t.appointments}, payments, notes and tags move across.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
            <RadioGroup aria-label="Profile to keep" value={chosen.id} onValueChange={(value) => setKeepId(String(value))} className="grid gap-3 sm:grid-cols-2">
              {[pair.a, pair.b].map((side) => (
                <label key={side.id} className="flex min-h-11 cursor-pointer items-start gap-2">
                  <Radio value={side.id} aria-label={`Keep ${side.name}`} className="mt-3" />
                  <SideSummary side={side} keep={side.id === chosen.id} />
                </label>
              ))}
            </RadioGroup>
            <p className="text-muted-foreground text-sm">Their messaging choices are not combined: {chosen.name} keeps their own. You can undo the merge for {UNDO_WINDOW_DAYS} days.</p>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? <Spinner /> : null}Keep {chosen.name} and merge</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** Step one of "Merge with…" on a profile: find the other profile by name, phone or email. */
export function MergeWithDialog({ current, open, onOpenChange, onMerged }: { current: DuplicateSide; open: boolean; onOpenChange: (open: boolean) => void; onMerged?: (result: MergeResult) => void }) {
  const t = useTerms();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<DuplicateSide | null>(null);
  const search = usePatientSearch(query, open && !picked);

  if (picked) {
    return <MergeDialog pair={{ a: current, b: picked }} open={open} onOpenChange={(next) => { if (!next) setPicked(null); onOpenChange(next); }} onMerged={onMerged} />;
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Merge {current.name} with another profile</DialogTitle>
          <DialogDescription>Search for the other profile of the same person.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <div className="relative">
            <Search aria-hidden="true" className="-translate-y-1/2 pointer-events-none absolute start-3 top-1/2 size-4 text-muted-foreground" />
            <Input aria-label={`Search ${t.customers}`} className="ps-9" placeholder="Name, phone or email" value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" />
          </div>
          {search.failed ? <LoadFailed message="The search could not be completed." onRetry={search.retry} /> : null}
          {search.searching ? <p role="status" className="flex items-center gap-2 text-muted-foreground text-sm"><Spinner />Searching…</p> : null}
          {!search.searching && !search.failed && query.trim().length >= 2 && search.patients.filter((item) => item.id !== current.id).length === 0 ? <p className="text-muted-foreground text-sm">No other {t.customer} matches that.</p> : null}
          <ul className="flex flex-col gap-1">
            {search.patients.filter((item) => item.id !== current.id).map((item) => (
              <li key={item.id}>
                <button type="button" className="flex min-h-11 w-full flex-col items-start rounded-md px-3 py-2 text-start hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => setPicked({ id: item.id, name: `${item.firstName} ${item.lastName}`.trim(), phone: item.phone, email: item.email, dateOfBirth: null, visits: 0, lastVisitAt: null })}>
                  <span className="font-medium text-sm">{`${item.firstName} ${item.lastName}`.trim()}</span>
                  <span className="text-muted-foreground text-xs tabular-nums">{item.phone}{item.email ? ` · ${item.email}` : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        </DialogPanel>
        <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button></DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
