"use client";

import { Bookmark, Plus, Trash2, TriangleAlert, Users } from "lucide-react";
import { type FormEvent, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { type SavedView, type SavedViewInput, SAVED_VIEW_NAME_MAX, workspaceTabLabels } from "@/lib/bookings-list";

import { createSavedView, deleteSavedView } from "./bookings-data";
import { StaffApiError } from "./queries/http";
import { ScrollArea } from "@/components/ui/scroll-area";

/** Naming the view you are looking at and choosing whether the team sees it. */
function SaveViewDialog({ current, onClose, onSaved }: { current: Omit<SavedViewInput, "name" | "shared">; onClose: () => void; onSaved: (view: SavedView) => void }) {
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [nameError, setNameError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (name.trim().length < 2) { setNameError("Give the view a name of at least 2 letters."); return; }
    setPending(true); setError(""); setNameError("");
    try {
      onSaved(await createSavedView({ ...current, name: name.trim(), shared }));
    } catch (cause: unknown) {
      if (cause instanceof StaffApiError && (cause.code === "view_exists" || cause.fieldErrors.name)) setNameError(cause.fieldErrors.name?.[0] ?? cause.message);
      else setError(cause instanceof Error && cause.message ? cause.message : "The view could not be saved. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <DialogPopup showCloseButton={!pending}>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>Save this view</DialogTitle>
            <DialogDescription>Keeps the {workspaceTabLabels[current.tab]} tab, the filters, the order and the columns you see now.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {error ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
            <Field invalid={Boolean(nameError)}>
              <FieldLabel>View name</FieldLabel>
              <Input aria-label="View name" value={name} maxLength={SAVED_VIEW_NAME_MAX} autoFocus disabled={pending} placeholder="For example, Next week" aria-invalid={Boolean(nameError)} onChange={(event) => setName(event.target.value)} />
              {nameError ? <FieldError match>{nameError}</FieldError> : null}
            </Field>
            <Label className="min-h-11 justify-between gap-4 sm:min-h-0">
              <span className="flex flex-col"><span>Share with the team</span><span className="text-xs font-normal text-muted-foreground">Everyone can use it. Only you can remove it.</span></span>
              <Switch checked={shared} onCheckedChange={setShared} disabled={pending} aria-label="Share with the team" />
            </Label>
          </DialogPanel>
          <DialogFooter>
            <DialogClose disabled={pending} render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
            <Button type="submit" loading={pending}>Save view</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Saved views in one dropdown: the team's shared views and your own. Picking one shows its tab, filters,
 * order and columns. Your own can be removed from the list.
 */
export function BookingViewsMenu({ views, loading, failed, current, canSave, onApply, onChanged }: {
  views: SavedView[];
  loading: boolean;
  failed: boolean;
  current: Omit<SavedViewInput, "name" | "shared">;
  canSave: boolean;
  onApply: (view: SavedView) => void;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const groups = [{ title: "Shared with the team", items: views.filter((view) => view.shared) }, { title: "Only you", items: views.filter((view) => !view.shared) }].filter((group) => group.items.length > 0);

  async function remove(view: SavedView) {
    setRemoving(view.id); setError("");
    try { await deleteSavedView(view.id); onChanged(); toastManager.add({ title: `Removed "${view.name}"`, type: "success" }); }
    catch (cause: unknown) { setError(cause instanceof Error && cause.message ? cause.message : "That view could not be removed."); }
    finally { setRemoving(null); }
  }

  return (
    <>
      <Popover>
        <PopoverTrigger render={<Button variant="outline" size="sm" className="shrink-0" />}><Bookmark aria-hidden="true" />Views</PopoverTrigger>
        <PopoverPopup align="start" className="w-[min(20rem,calc(100vw-2rem))]">
          <ScrollArea className="flex h-auto! max-h-[min(24rem,60svh)] flex-col">
          <div className="flex flex-col gap-2">
            {loading ? <Skeleton className="h-9 w-full" /> : null}
            {failed ? <p role="alert" className="text-sm text-destructive-foreground">Saved views could not be loaded.</p> : null}
            {!loading && !failed && groups.length === 0 ? <p className="px-1 text-sm text-muted-foreground">No saved views yet. Set up the filters you use, then save them here.</p> : null}
            {error ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
            {groups.map((group) => (
              <section key={group.title} aria-label={group.title} className="flex flex-col gap-0.5">
                <h3 className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">{group.title === "Only you" ? null : <Users aria-hidden="true" className="size-3.5" />}{group.title}</h3>
                {group.items.map((view) => (
                  <div key={view.id} className="flex items-center gap-1">
                    <PopoverClose render={<Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start pointer-coarse:min-h-11" onClick={() => onApply(view)} />}>
                      <span className="truncate">{view.name}</span><span className="ms-auto shrink-0 text-xs font-normal text-muted-foreground">{workspaceTabLabels[view.tab]}</span>
                    </PopoverClose>
                    {view.mine ? <Button size="icon-sm" variant="ghost" aria-label={`Remove view ${view.name}`} loading={removing === view.id} onClick={() => void remove(view)}><Trash2 aria-hidden="true" /></Button> : null}
                  </div>
                ))}
              </section>
            ))}
          </div>
          </ScrollArea>
          {canSave ? (
            <div className="mt-2 border-t pt-2">
              <PopoverClose render={<Button variant="ghost" size="sm" className="w-full justify-start pointer-coarse:min-h-11" onClick={() => setSaving(true)} />}><Plus aria-hidden="true" />Save current view…</PopoverClose>
            </div>
          ) : null}
        </PopoverPopup>
      </Popover>
      {saving ? <SaveViewDialog current={current} onClose={() => setSaving(false)} onSaved={(view) => { setSaving(false); onChanged(); toastManager.add({ title: `Saved "${view.name}"`, description: view.shared ? "The team can use it now." : "Only you can see it.", type: "success" }); }} /> : null}
    </>
  );
}
