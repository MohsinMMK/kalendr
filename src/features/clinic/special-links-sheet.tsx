"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Copy, Link2, TriangleAlert, Users } from "lucide-react";
import { useState, type FormEvent } from "react";

import { OptionSelect, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Drawer, DrawerDescription, DrawerHeader, DrawerPanel, DrawerPopup, DrawerTitle } from "@/components/ui/drawer";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { Practitioner } from "@/lib/domain";
import { type CombinedLinkView, type SpecialLinkKind, type SpecialLinkStatus, type SpecialLinkView, specialLinkPath } from "@/lib/special-links";

import { useCatalogLookups } from "./clinic-catalog";
import { StaffApiError, staffMutation, staffQuery } from "./queries/http";

const kindOptions: { value: SpecialLinkKind; label: string }[] = [
  { value: "single_use", label: "One booking, then it stops" },
  { value: "limited", label: "A set number of bookings" },
  { value: "expiring", label: "Until a date and time" },
];

const statusBadge: Record<SpecialLinkStatus, { label: string; variant: "success" | "outline" | "warning" | "error" }> = {
  active: { label: "Active", variant: "success" },
  used_up: { label: "Used up", variant: "outline" },
  expired: { label: "Expired", variant: "warning" },
  revoked: { label: "Revoked", variant: "error" },
};

function whenText(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** Copies text and says so; a blocked clipboard falls back to a message that names the problem. */
async function copyText(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toastManager.add({ title: done, type: "success" });
  } catch {
    toastManager.add({ title: "Could not copy. Select the link and copy it by hand.", type: "error" });
  }
}

function fieldErrorsOf(cause: unknown): Record<string, string> {
  if (!(cause instanceof StaffApiError)) return {};
  return Object.fromEntries(Object.entries(cause.fieldErrors).map(([path, messages]) => [path, messages[0] ?? ""]));
}

function LinkList({ serviceId }: { serviceId: string }) {
  const client = useQueryClient();
  const key = ["staff", "special-links", serviceId] as const;
  const list = useQuery({ queryKey: key, queryFn: ({ signal }) => staffQuery<{ links: SpecialLinkView[] }>(`/api/staff/special-links?serviceId=${serviceId}`, signal) });
  const [kind, setKind] = useState<SpecialLinkKind>("single_use");
  const [label, setLabel] = useState("");
  const [maxUses, setMaxUses] = useState("10");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("23:59");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [fresh, setFresh] = useState<{ label: string; url: string } | null>(null);
  const [revoking, setRevoking] = useState<SpecialLinkView | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const expiresAt = date ? new Date(`${date}T${time || "23:59"}`).toISOString() : undefined;
      return staffMutation<{ id: string; token: string; path: string }>("/api/staff/special-links", "POST", {
        serviceId, label: label.trim(), kind,
        ...(kind === "limited" ? { maxUses: Number(maxUses) } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      });
    },
    onSuccess: async (result) => {
      setErrors({}); setError("");
      setFresh({ label: label.trim(), url: `${window.location.origin}${specialLinkPath(result.token)}` });
      setLabel("");
      await client.invalidateQueries({ queryKey: key });
    },
    onError: (cause: unknown) => {
      const fields = fieldErrorsOf(cause);
      setErrors(fields);
      if (Object.keys(fields).length === 0) setError(cause instanceof Error ? cause.message : "The link could not be made. Try again.");
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => staffMutation<{ revoked: true }>(`/api/staff/special-links/${id}`, "DELETE", {}),
    onSuccess: async () => { setRevoking(null); toastManager.add({ title: "Link revoked. It stops working now.", type: "success" }); await client.invalidateQueries({ queryKey: key }); },
    onError: (cause: unknown) => { setRevoking(null); setError(cause instanceof Error ? cause.message : "The link could not be revoked."); },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setErrors({}); setError("");
    if (!label.trim()) { setErrors({ label: "Give the link a name you will recognise." }); return; }
    if (kind === "expiring" && !date) { setErrors({ expiresAt: "Choose when it stops working." }); return; }
    if (kind === "limited" && !(Number(maxUses) >= 2)) { setErrors({ maxUses: "Enter 2 or more." }); return; }
    create.mutate();
  }

  const links = list.data?.links ?? [];
  return (
    <div className="flex flex-col gap-4">
      {error ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
      {fresh ? (
        <Alert variant="success">
          <Check aria-hidden="true" />
          <AlertDescription className="flex flex-col gap-2">
            <span>“{fresh.label}” is ready. Copy it now: this is the only time the full link is shown.</span>
            <code className="break-all rounded bg-muted px-2 py-1 text-xs">{fresh.url}</code>
            <span className="flex gap-2"><Button size="sm" onClick={() => void copyText(fresh.url, "Link copied.")}><Copy aria-hidden="true" /> Copy link</Button><Button size="sm" variant="ghost" onClick={() => setFresh(null)}>Done</Button></span>
          </AlertDescription>
        </Alert>
      ) : null}
      <form onSubmit={submit} noValidate aria-label="Make a special link" className="flex flex-col gap-3 rounded-lg border p-3">
        <TextField label="Name" placeholder="For Priya, free first visit" maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} error={errors.label} />
        <div className="flex flex-col gap-1.5"><span className="font-medium text-sm">How it works</span><OptionSelect aria-label="How it works" value={kind} onValueChange={(next) => setKind(kindOptions.find((option) => option.value === next)?.value ?? "single_use")} options={kindOptions} /></div>
        {kind === "limited" ? <TextField label="Number of bookings" type="number" inputMode="numeric" min={2} max={1000} value={maxUses} onChange={(event) => setMaxUses(event.target.value)} error={errors.maxUses} fieldClassName="sm:w-48" /> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label={kind === "expiring" ? "Stops working on" : "Also stop on"} optional={kind !== "expiring"} type="date" value={date} onChange={(event) => setDate(event.target.value)} error={errors.expiresAt} />
          <TextField label="At (your time)" type="time" value={time} onChange={(event) => setTime(event.target.value)} disabled={!date} />
        </div>
        <Button type="submit" loading={create.isPending} className="self-start"><Link2 aria-hidden="true" /> Make link</Button>
      </form>
      {list.isPending ? <div role="status" aria-label="Loading links" className="flex flex-col gap-2"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div> : null}
      {list.isError ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription className="flex flex-wrap items-center gap-2">The links could not be loaded.<Button size="sm" variant="outline" onClick={() => void list.refetch()}>Try again</Button></AlertDescription></Alert> : null}
      {list.data && links.length === 0 ? (
        <Empty><EmptyHeader><EmptyMedia variant="icon"><Link2 aria-hidden="true" /></EmptyMedia><EmptyTitle>No special links yet</EmptyTitle><EmptyDescription>Make one above to give a person a private way to book.</EmptyDescription></EmptyHeader></Empty>
      ) : null}
      {links.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="Special links">
          {links.map((link) => {
            const badge = statusBadge[link.status];
            return (
              <li key={link.id} className="rounded-lg border">
                <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium text-sm"><span className="truncate">{link.label}</span><Badge variant={badge.variant}>{badge.label}</Badge></p>
                    <p className="text-muted-foreground text-xs">
                      {link.maxUses ? `${link.usedCount} of ${link.maxUses} used` : `${link.usedCount} used`}{link.expiresAt ? ` · until ${whenText(link.expiresAt)}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button size="sm" variant="outline" aria-expanded={open === link.id} onClick={() => setOpen(open === link.id ? null : link.id)}>Bookings ({link.bookings.length}) <ChevronDown aria-hidden="true" /></Button>
                    {link.status === "active" ? <Button size="sm" variant="destructive-outline" onClick={() => setRevoking(link)}>Revoke</Button> : null}
                  </div>
                </div>
                {open === link.id ? (
                  <div className="border-t px-3 py-2">
                    {link.bookings.length === 0 ? <p className="text-muted-foreground text-xs">No bookings through this link yet.</p> : (
                      <ul className="flex flex-col gap-1 text-sm">{link.bookings.map((booking) => <li key={booking.appointmentId} className="flex justify-between gap-2"><span>{booking.customerName}</span><span className="text-muted-foreground tabular-nums">{whenText(booking.startsAt)} · {booking.status.replace(/_/g, " ")}</span></li>)}</ul>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <AlertDialog open={revoking !== null} onOpenChange={(next) => { if (!next && !revoke.isPending) setRevoking(null); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this link?</AlertDialogTitle>
            <AlertDialogDescription>“{revoking?.label}” stops working at once. Bookings already made through it stay.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="ghost" disabled={revoke.isPending} onClick={() => setRevoking(null)}>Keep it</Button>
            <Button variant="destructive" loading={revoke.isPending} onClick={() => revoking && revoke.mutate(revoking.id)}>Revoke</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function CombinedList({ serviceId, people }: { serviceId: string; people: Practitioner[] }) {
  const client = useQueryClient();
  const catalog = useCatalogLookups();
  const key = ["staff", "combined-links", serviceId] as const;
  const list = useQuery({ queryKey: key, queryFn: ({ signal }) => staffQuery<{ links: CombinedLinkView[] }>(`/api/staff/combined-links?serviceId=${serviceId}`, signal) });
  const [label, setLabel] = useState("");
  const [slug, setSlug] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<CombinedLinkView | null>(null);
  const create = useMutation({
    mutationFn: () => staffMutation<{ id: string; slug: string }>("/api/staff/combined-links", "POST", { serviceId, label: label.trim(), slug: slug.trim().toLowerCase(), practitionerIds: chosen }),
    onSuccess: async () => { setLabel(""); setSlug(""); setChosen([]); setErrors({}); setError(""); toastManager.add({ title: "Link made.", type: "success" }); await client.invalidateQueries({ queryKey: key }); },
    onError: (cause: unknown) => { const fields = fieldErrorsOf(cause); setErrors(fields); if (Object.keys(fields).length === 0) setError(cause instanceof Error ? cause.message : "The link could not be made."); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => staffMutation<{ removed: true }>(`/api/staff/combined-links/${id}`, "DELETE", {}),
    onSuccess: async () => { setRemoving(null); toastManager.add({ title: "Link removed.", type: "success" }); await client.invalidateQueries({ queryKey: key }); },
    onError: (cause: unknown) => { setRemoving(null); setError(cause instanceof Error ? cause.message : "The link could not be removed."); },
  });
  const nameOf = (id: string) => people.find((person) => person.id === id)?.name ?? "Someone";
  const urlFor = (linkSlug: string) => `${window.location.origin}/b/${catalog.clinic.slug}/with/${linkSlug}`;
  function submit(event: FormEvent) {
    event.preventDefault();
    setErrors({}); setError("");
    if (!label.trim()) { setErrors({ label: "Give the link a name you will recognise." }); return; }
    if (chosen.length < 2) { setErrors({ practitionerIds: "Choose at least two people." }); return; }
    if (!slug.trim()) { setErrors({ slug: "Choose the end of the web address." }); return; }
    create.mutate();
  }
  const links = list.data?.links ?? [];
  return (
    <div className="flex flex-col gap-4">
      {error ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
      <form onSubmit={submit} noValidate aria-label="Make a combined link" className="flex flex-col gap-3 rounded-lg border p-3">
        <TextField label="Name" placeholder="Couples session" maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} error={errors.label} />
        <fieldset className="flex flex-col gap-1" aria-invalid={errors.practitionerIds ? true : undefined} aria-describedby={errors.practitionerIds ? "combined-people-error" : undefined}>
          <legend className="mb-1 font-medium text-sm">Who is booked together (2 to 4)</legend>
          {people.map((person) => (
            <Label key={person.id} className="min-h-11 sm:min-h-0"><Checkbox checked={chosen.includes(person.id)} disabled={!chosen.includes(person.id) && chosen.length >= 4} onCheckedChange={(next) => setChosen((current) => next === true ? [...current, person.id] : current.filter((id) => id !== person.id))} />{person.name}</Label>
          ))}
          {errors.practitionerIds ? <p id="combined-people-error" role="alert" className="text-destructive-foreground text-xs">{errors.practitionerIds}</p> : null}
        </fieldset>
        <TextField label="Web address ends with" placeholder="couples" value={slug} onChange={(event) => setSlug(event.target.value)} error={errors.slug} hint="Letters, numbers and dashes." />
        <Button type="submit" loading={create.isPending} className="self-start"><Users aria-hidden="true" /> Make link</Button>
      </form>
      {list.isPending ? <Skeleton role="status" aria-label="Loading links" className="h-14 w-full" /> : null}
      {list.isError ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription className="flex flex-wrap items-center gap-2">The links could not be loaded.<Button size="sm" variant="outline" onClick={() => void list.refetch()}>Try again</Button></AlertDescription></Alert> : null}
      {list.data && links.length === 0 ? <Empty><EmptyHeader><EmptyMedia variant="icon"><Users aria-hidden="true" /></EmptyMedia><EmptyTitle>No combined links yet</EmptyTitle><EmptyDescription>A combined link offers only times when everyone on it is free, and books them all at once.</EmptyDescription></EmptyHeader></Empty> : null}
      {links.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="Combined links">
          {links.map((link) => (
            <li key={link.id} className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1"><p className="truncate font-medium text-sm">{link.label}</p><p className="truncate text-muted-foreground text-xs">{link.practitionerIds.map(nameOf).join(" and ")} · /with/{link.slug}</p></div>
              <div className="flex shrink-0 gap-2"><Button size="sm" variant="outline" onClick={() => void copyText(urlFor(link.slug), "Link copied.")}><Copy aria-hidden="true" /> Copy</Button><Button size="sm" variant="destructive-outline" onClick={() => setRemoving(link)}>Remove</Button></div>
            </li>
          ))}
        </ul>
      ) : null}
      <AlertDialog open={removing !== null} onOpenChange={(next) => { if (!next && !remove.isPending) setRemoving(null); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this link?</AlertDialogTitle>
            <AlertDialogDescription>“{removing?.label}” stops working at once. Bookings already made through it stay.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="ghost" disabled={remove.isPending} onClick={() => setRemoving(null)}>Keep it</Button>
            <Button variant="destructive" loading={remove.isPending} onClick={() => removing && remove.mutate(removing.id)}>Remove</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

/** The sheet behind a service's ⋯ → Special links (feature 45): one-off links and combined links. */
export function SpecialLinksSheet({ serviceId, serviceName, open, onOpenChange }: { serviceId: string; serviceName: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const isPhone = useMediaQuery("(max-width: 767px)");
  const people = catalog.practitioners.filter((person) => catalog.services.find((service) => service.id === serviceId)?.practitionerIds.includes(person.id));
  if (!open) return null;
  return (
    <Drawer open onOpenChange={onOpenChange} position={isPhone ? "bottom" : "right"}>
      <DrawerPopup showBar={isPhone} className="sm:max-w-xl">
        <DrawerHeader>
          <DrawerTitle>Special links</DrawerTitle>
          <DrawerDescription>Private ways to book {serviceName}: once, a few times, until a date, or for several {t.providers} together.</DrawerDescription>
        </DrawerHeader>
        <DrawerPanel>
          {!catalog.database ? <p className="rounded-lg bg-muted/60 px-3 py-2 text-muted-foreground text-xs">Special links are saved on the {t.business} database, so they are not available in the preview.</p> : (
            <Tabs defaultValue="single">
              <TabsList variant="underline" aria-label="Kinds of special link"><TabsTab value="single" className="min-h-11">One-off links</TabsTab><TabsTab value="together" className="min-h-11">Booked together</TabsTab></TabsList>
              <TabsPanel value="single" className="pt-4"><LinkList serviceId={serviceId} /></TabsPanel>
              <TabsPanel value="together" className="pt-4"><CombinedList serviceId={serviceId} people={people} /></TabsPanel>
            </Tabs>
          )}
        </DrawerPanel>
      </DrawerPopup>
    </Drawer>
  );
}
