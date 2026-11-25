"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers, Lock, Plus, TriangleAlert, X } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { OptionSelect, TextField } from "@/components/form-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerDescription, DrawerFooter, DrawerHeader, DrawerPanel, DrawerPopup, DrawerTitle } from "@/components/ui/drawer";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import { Textarea } from "@/components/ui/textarea";
import { useTerms } from "@/features/terms/business-profile-context";
import { useMediaQuery } from "@/hooks/use-media-query";
import { type LockableField, type PublishSummary, type TemplateDetail, type TemplateSettings, type TemplateView, lockLabels, lockableFields } from "@/lib/service-templates";

import { useCatalogLookups } from "./clinic-catalog";
import { priceFromText, priceText } from "./service-editor-model";
import { staffMutation, staffQuery } from "./queries/http";

const listKey = ["staff", "service-templates"] as const;
const detailKey = (id: string) => ["staff", "service-templates", id] as const;
const problem = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

function LockChips({ fields }: { fields: readonly LockableField[] }) {
  if (fields.length === 0) return <span className="text-muted-foreground text-xs">Nothing locked</span>;
  return <span className="flex flex-wrap gap-1">{fields.map((field) => <Badge key={field} variant="outline" size="sm"><Lock aria-hidden="true" /> {lockLabels[field]}</Badge>)}</span>;
}

function LockPicker({ value, onChange, disabled }: { value: LockableField[]; onChange: (next: LockableField[]) => void; disabled?: boolean }) {
  const t = useTerms();
  return (
    <fieldset className="flex flex-col" disabled={disabled}>
      <legend className="mb-1 font-medium text-sm">Locked on every copy</legend>
      <p className="mb-2 text-muted-foreground text-xs">Locked fields can only be changed here. Each {t.location} can still change everything else.</p>
      <div className="grid gap-x-4 sm:grid-cols-2">
        {lockableFields.map((field) => (
          <Label key={field} className="min-h-11 font-normal sm:min-h-9">
            <Checkbox checked={value.includes(field)} onCheckedChange={(on) => onChange(on === true ? [...value, field] : value.filter((entry) => entry !== field))} />
            {lockLabels[field]}
          </Label>
        ))}
      </div>
    </fieldset>
  );
}

function NewTemplateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const client = useQueryClient();
  const catalog = useCatalogLookups();
  const t = useTerms();
  const [name, setName] = useState("");
  const [from, setFrom] = useState("");
  const [locked, setLocked] = useState<LockableField[]>(["prices"]);
  const [error, setError] = useState("");
  const [nameError, setNameError] = useState("");
  const create = useMutation({
    mutationFn: () => staffMutation<TemplateView>("/api/staff/service-templates", "POST", { name: name.trim(), lockedFields: locked, ...(from ? { fromServiceId: from } : {}) }),
    onSuccess: async () => { setName(""); setFrom(""); onOpenChange(false); toastManager.add({ title: "Template made.", type: "success" }); await client.invalidateQueries({ queryKey: listKey }); },
    onError: (cause: unknown) => setError(problem(cause, "The template could not be made. Try again.")),
  });
  const services = catalog.services.filter((service) => service.isActive !== false);
  function submit(event: FormEvent) {
    event.preventDefault();
    setError(""); setNameError("");
    if (name.trim().length < 2) { setNameError("Give the template a name."); return; }
    create.mutate();
  }
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!create.isPending) onOpenChange(next); }}>
      <DialogPopup>
        <form onSubmit={submit} noValidate className="contents">
          <DialogHeader>
            <DialogTitle>New template</DialogTitle>
            <DialogDescription>Define a {t.service} once, then give it to every {t.location}.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {error ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
            <TextField label="Name" placeholder="Standard haircut" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} error={nameError} />
            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-sm">Start from</span>
              <OptionSelect aria-label="Start from" value={from} onValueChange={setFrom} placeholder="A blank template" options={[{ value: "", label: "A blank template" }, ...services.map((service) => ({ value: service.id, label: `A copy of ${service.name}` }))]} />
              <span className="text-muted-foreground text-xs">Copying a {t.service} brings its lengths, prices, timing, approval and cancelling rules.</span>
            </div>
            <LockPicker value={locked} onChange={setLocked} />
          </DialogPanel>
          <DialogFooter>
            <DialogClose disabled={create.isPending} render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
            <Button type="submit" loading={create.isPending}>Make template</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

interface Draft {
  name: string;
  description: string;
  category: string;
  visibility: "listed" | "hidden";
  lengths: TemplateSettings["lengths"];
  locked: LockableField[];
}

const draftOf = (detail: TemplateDetail): Draft => ({
  name: detail.name, description: detail.settings.description, category: detail.settings.category ?? "", visibility: detail.settings.visibility,
  lengths: detail.settings.lengths, locked: detail.lockedFields,
});

function TemplateDrawer({ templateId, onClose }: { templateId: string; onClose: () => void }) {
  const t = useTerms();
  const client = useQueryClient();
  const catalog = useCatalogLookups();
  const isPhone = useMediaQuery("(max-width: 767px)");
  const detail = useQuery({ queryKey: detailKey(templateId), queryFn: ({ signal }) => staffQuery<TemplateDetail>(`/api/staff/service-templates/${templateId}`, signal) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<PublishSummary | null>(null);
  const [priceDrafts, setPriceDrafts] = useState<Record<number, string>>({});
  const [branches, setBranches] = useState<string[]>([]);
  const [linking, setLinking] = useState<string[]>([]);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (detail.data) queueMicrotask(() => setDraft((current) => current ?? draftOf(detail.data)));
  }, [detail.data]);

  const refresh = async () => { await client.invalidateQueries({ queryKey: ["staff", "service-templates"] }); };
  const body = (dryRun: boolean) => {
    if (!detail.data || !draft) throw new Error("Not loaded");
    return {
      expectedVersion: detail.data.version, dryRun, name: draft.name.trim(), lockedFields: draft.locked,
      settings: { ...detail.data.settings, description: draft.description.trim(), category: draft.category.trim() || null, visibility: draft.visibility, lengths: draft.lengths },
    };
  };
  const preview = useMutation({
    mutationFn: () => staffMutation<{ summary: PublishSummary }>(`/api/staff/service-templates/${templateId}`, "PATCH", body(true)),
    onSuccess: (result) => { setError(""); setSummary(result.summary); },
    onError: (cause: unknown) => setError(problem(cause, "The change could not be checked.")),
  });
  const publish = useMutation({
    mutationFn: () => staffMutation<{ summary: PublishSummary }>(`/api/staff/service-templates/${templateId}`, "PATCH", body(false)),
    onSuccess: async () => { setSummary(null); setDraft(null); toastManager.add({ title: "Published. Every copy is up to date.", type: "success" }); await refresh(); },
    onError: (cause: unknown) => { setSummary(null); setError(problem(cause, "The change could not be published.")); },
  });
  const assign = useMutation({
    mutationFn: () => staffMutation<{ created: string[]; linked: string[] }>(`/api/staff/service-templates/${templateId}/assign`, "POST", { locationIds: branches, linkServiceIds: linking }),
    onSuccess: async (result) => { setBranches([]); setLinking([]); toastManager.add({ title: `${result.created.length} made, ${result.linked.length} linked.`, type: "success" }); await refresh(); },
    onError: (cause: unknown) => setError(problem(cause, "The template could not be assigned.")),
  });
  const unlink = useMutation({
    mutationFn: (serviceId: string) => staffMutation<{ unlinked: number }>(`/api/staff/service-templates/${templateId}/assign`, "DELETE", { serviceIds: [serviceId] }),
    onSuccess: async () => { setUnlinking(null); toastManager.add({ title: `Unlinked. It keeps its settings and is now a normal ${t.service}.`, type: "success" }); await refresh(); },
    onError: (cause: unknown) => { setUnlinking(null); setError(problem(cause, `The ${t.service} could not be unlinked.`)); },
  });
  const remove = useMutation({
    mutationFn: () => staffMutation<{ unlinked: number }>(`/api/staff/service-templates/${templateId}`, "DELETE", {}),
    onSuccess: async () => { toastManager.add({ title: `Template deleted. Its ${t.services} stay.`, type: "success" }); await refresh(); onClose(); },
    onError: (cause: unknown) => { setConfirmDelete(false); setError(problem(cause, "The template could not be deleted.")); },
  });

  const free = useMemo(() => {
    const taken = new Set(detail.data?.copies.map((copy) => copy.serviceId));
    return catalog.services.filter((service) => !taken.has(service.id) && service.isActive !== false);
  }, [catalog.services, detail.data]);
  const dirty = Boolean(detail.data && draft && JSON.stringify(draft) !== JSON.stringify(draftOf(detail.data)));
  const setLength = (index: number, patch: Partial<TemplateSettings["lengths"][number]>) => setDraft((current) => current && { ...current, lengths: current.lengths.map((length, at) => (at === index ? { ...length, ...patch } : length)) });

  return (
    <Drawer open onOpenChange={(next) => { if (!next) onClose(); }} position={isPhone ? "bottom" : "right"}>
      <DrawerPopup showBar={isPhone} className="sm:max-w-xl">
        <DrawerHeader>
          <DrawerTitle>{detail.data?.name ?? "Template"}</DrawerTitle>
          <DrawerDescription>{detail.data ? `Version ${detail.data.version} · used by ${detail.data.copyCount} ${detail.data.copyCount === 1 ? t.service : t.services}` : "Loading…"}</DrawerDescription>
        </DrawerHeader>
        <DrawerPanel>
          {detail.isPending ? <div role="status" aria-label="Loading the template" className="flex flex-col gap-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-24 w-full" /></div> : null}
          {detail.isError ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription className="flex flex-wrap items-center gap-2">The template could not be loaded.<Button size="sm" variant="outline" onClick={() => void detail.refetch()}>Try again</Button></AlertDescription></Alert> : null}
          {error ? <Alert variant="error" className="mb-3"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
          {detail.data && draft ? (
            <Tabs defaultValue="settings">
              <TabsList variant="underline" aria-label="Template"><TabsTab value="settings" className="min-h-11">Settings</TabsTab><TabsTab value="locks" className="min-h-11">Locks</TabsTab><TabsTab value="services" className="min-h-11">{t.Services} ({detail.data.copyCount})</TabsTab></TabsList>
              <TabsPanel value="settings" className="flex flex-col gap-4 pt-4">
                <TextField label="Name" maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                <div className="flex flex-col gap-1.5"><Label htmlFor="template-description">Description</Label><Textarea id="template-description" value={draft.description} maxLength={2000} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextField label="Category" optional maxLength={60} value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} />
                  <div className="flex flex-col gap-1.5"><span className="font-medium text-sm">On the booking page</span><OptionSelect aria-label="On the booking page" value={draft.visibility} onValueChange={(next) => setDraft({ ...draft, visibility: next === "hidden" ? "hidden" : "listed" })} options={[{ value: "listed", label: "Listed" }, { value: "hidden", label: "Hidden (link only)" }]} /></div>
                </div>
                <section aria-label="Lengths and prices" className="flex flex-col gap-2">
                  <h3 className="font-medium text-sm">Lengths and prices</h3>
                  {draft.lengths.map((length, index) => {
                    const text = priceDrafts[index] ?? priceText(length.priceMinor);
                    const parsed = priceFromText(text);
                    return (
                      <div key={index} className="grid grid-cols-2 gap-3 rounded-lg border p-3">
                        <TextField label="Minutes" type="number" inputMode="numeric" min={5} max={480} value={String(length.minutes)} onChange={(event) => setLength(index, { minutes: Number(event.target.value) || 0 })} />
                        <TextField label="Price (₹)" optional inputMode="decimal" value={text} error={parsed === undefined ? "Enter an amount like 800 or 800.50." : undefined}
                          onChange={(event) => { setPriceDrafts((drafts) => ({ ...drafts, [index]: event.target.value })); const next = priceFromText(event.target.value); if (next !== undefined) setLength(index, { priceMinor: next }); }} />
                      </div>
                    );
                  })}
                </section>
                <p className="text-muted-foreground text-xs">Timing, approval, cancelling and the other settings come from the {t.service} you copied. To change them, set up a {t.service}, then make a new template from it.</p>
              </TabsPanel>
              <TabsPanel value="locks" className="pt-4"><LockPicker value={draft.locked} onChange={(locked) => setDraft({ ...draft, locked })} /></TabsPanel>
              <TabsPanel value="services" className="flex flex-col gap-4 pt-4">
                <section aria-label={`${t.Services} using this template`} className="flex flex-col gap-2">
                  {detail.data.copies.length === 0 ? (
                    <Empty><EmptyHeader><EmptyMedia variant="icon"><Layers aria-hidden="true" /></EmptyMedia><EmptyTitle>No {t.services} yet</EmptyTitle><EmptyDescription>Give it to {t.locations} below.</EmptyDescription></EmptyHeader></Empty>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {detail.data.copies.map((copy) => (
                        <li key={copy.serviceId} className="flex items-center gap-3 rounded-lg border p-3">
                          <div className="min-w-0 flex-1"><p className="truncate font-medium text-sm">{copy.name}</p><p className="truncate text-muted-foreground text-xs">{copy.locationNames.join(", ") || `No ${t.location}`}{copy.outOfDate ? " · behind the template" : ""}</p></div>
                          <Button size="icon-sm" variant="ghost" aria-label={`Unlink ${copy.name}`} onClick={() => setUnlinking(copy.serviceId)}><X aria-hidden="true" /></Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section aria-label={`Give it to ${t.locations}`} className="flex flex-col gap-2 rounded-lg border p-3">
                  <h3 className="font-medium text-sm">Make it in a {t.location}</h3>
                  <p className="text-muted-foreground text-xs">One {t.service} is made in each {t.location} you choose, offered by everyone who works there.</p>
                  {catalog.locations.filter((place) => place.isActive !== false).map((place) => (
                    <Label key={place.id} className="min-h-11 font-normal sm:min-h-9"><Checkbox checked={branches.includes(place.id)} onCheckedChange={(on) => setBranches((current) => on === true ? [...current, place.id] : current.filter((id) => id !== place.id))} />{place.name}</Label>
                  ))}
                  {free.length > 0 ? <h3 className="mt-2 font-medium text-sm">Or link a {t.service} you already have</h3> : null}
                  {free.map((service) => (
                    <Label key={service.id} className="min-h-11 font-normal sm:min-h-9"><Checkbox checked={linking.includes(service.id)} onCheckedChange={(on) => setLinking((current) => on === true ? [...current, service.id] : current.filter((id) => id !== service.id))} />{service.name}</Label>
                  ))}
                  {linking.length > 0 ? <p className="text-muted-foreground text-xs">Linked {t.services} take the template’s locked fields at once.</p> : null}
                  <Button className="self-start" disabled={branches.length + linking.length === 0 || dirty} loading={assign.isPending} onClick={() => assign.mutate()}><Plus aria-hidden="true" /> Assign</Button>
                  {dirty ? <p className="text-muted-foreground text-xs">Publish your changes first.</p> : null}
                </section>
              </TabsPanel>
            </Tabs>
          ) : null}
        </DrawerPanel>
        <DrawerFooter variant="bare" className="flex-row items-center justify-between sm:justify-between">
          <Button variant="destructive-outline" onClick={() => setConfirmDelete(true)} disabled={!detail.data}>Delete</Button>
          <Button size="lg" disabled={!dirty} loading={preview.isPending} onClick={() => preview.mutate()}>Review and publish</Button>
        </DrawerFooter>
      </DrawerPopup>
      <AlertDialog open={summary !== null} onOpenChange={(next) => { if (!next && !publish.isPending) setSummary(null); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish this change?</AlertDialogTitle>
            <AlertDialogDescription>{summary?.sentence}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="ghost" disabled={publish.isPending} onClick={() => setSummary(null)}>Keep editing</Button>
            <Button loading={publish.isPending} onClick={() => publish.mutate()}>Publish</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog open={unlinking !== null} onOpenChange={(next) => { if (!next && !unlink.isPending) setUnlinking(null); }}>
        <AlertDialogPopup>
          <AlertDialogHeader><AlertDialogTitle>Unlink this {t.service}?</AlertDialogTitle><AlertDialogDescription>It keeps its current settings and becomes a normal {t.service}. Nothing locked will follow the template any more.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><Button variant="ghost" onClick={() => setUnlinking(null)}>Keep linked</Button><Button variant="destructive" loading={unlink.isPending} onClick={() => unlinking && unlink.mutate(unlinking)}>Unlink</Button></AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog open={confirmDelete} onOpenChange={(next) => { if (!next && !remove.isPending) setConfirmDelete(false); }}>
        <AlertDialogPopup>
          <AlertDialogHeader><AlertDialogTitle>Delete this template?</AlertDialogTitle><AlertDialogDescription>Its {t.services} stay as normal {t.services} with their current settings. This can’t be undone.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><Button variant="ghost" onClick={() => setConfirmDelete(false)}>Keep it</Button><Button variant="destructive" loading={remove.isPending} onClick={() => remove.mutate()}>Delete</Button></AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Drawer>
  );
}

/** Settings → Service templates (feature 48). */
export function TemplatesSettings() {
  const t = useTerms();
  const database = useCatalogLookups().database;
  const list = useQuery({ queryKey: listKey, queryFn: ({ signal }) => staffQuery<{ templates: TemplateView[] }>("/api/staff/service-templates", signal), enabled: database });
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  if (!database) {
    return (
      <Empty><EmptyHeader><EmptyMedia variant="icon"><Layers aria-hidden="true" /></EmptyMedia><EmptyTitle>Templates are not available in the preview</EmptyTitle><EmptyDescription>They are saved on the {t.business} database.</EmptyDescription></EmptyHeader></Empty>
    );
  }
  const templates = list.data?.templates ?? [];
  return (
    <Frame>
      <FrameHeader className="flex-row items-start justify-between gap-3">
        <div className="min-w-0">
          <FrameTitle>{t.Service} templates</FrameTitle>
          <FrameDescription>Define a {t.service} once, give it to every {t.location} and lock what each one must not change.</FrameDescription>
        </div>
        <Button size="sm" className="shrink-0" onClick={() => setCreating(true)}><Plus aria-hidden="true" /> New template</Button>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-3">
        {list.isPending ? <div role="status" aria-label="Loading templates" className="flex flex-col gap-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div> : null}
        {list.isError ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertTitle>Templates could not be loaded</AlertTitle><AlertDescription><Button size="sm" variant="outline" className="mt-1" onClick={() => void list.refetch()}>Try again</Button></AlertDescription></Alert> : null}
        {list.data && templates.length === 0 ? (
          <Empty><EmptyHeader><EmptyMedia variant="icon"><Layers aria-hidden="true" /></EmptyMedia><EmptyTitle>No templates yet</EmptyTitle><EmptyDescription>Make one from a {t.service} you already have, or start blank.</EmptyDescription></EmptyHeader></Empty>
        ) : null}
        {templates.length > 0 ? (
          <ul className="flex flex-col gap-2" aria-label="Templates">
            {templates.map((template) => (
              <li key={template.id} className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-sm">{template.name}</p>
                  <p className="mb-1 text-muted-foreground text-xs">Version {template.version} · {template.copyCount} {template.copyCount === 1 ? t.service : t.services}</p>
                  <LockChips fields={template.lockedFields} />
                </div>
                <Button size="sm" variant="outline" className="shrink-0 self-start sm:self-center" onClick={() => setOpen(template.id)}>Open</Button>
              </li>
            ))}
          </ul>
        ) : null}
      </FramePanel>
      <NewTemplateDialog open={creating} onOpenChange={setCreating} />
      {open ? <TemplateDrawer key={open} templateId={open} onClose={() => setOpen(null)} /> : null}
    </Frame>
  );
}
