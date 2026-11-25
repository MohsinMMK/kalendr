"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Search } from "lucide-react";

import { Sortable } from "@/components/reui/sortable";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import type { Service } from "@/lib/domain";
import { arrangeList, serviceOrderList, serviceOrderPage, withListLayout } from "@/lib/workspace-layout";

import { useCatalogLookups } from "./clinic-catalog";
import { serviceLink } from "./service-editor-model";
import { ServiceRow, type ServiceRowActions } from "./services-list-row";
import { useStaffAccess } from "./staff-access";
import { staffMutation, useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { usePageLayout } from "./workspace-layout-provider";

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** The business's own services: search, reorder, switch on or off, preview, copy the link, duplicate and delete. */
export function ServicesWorkspace() {
  const t = useTerms();
  const router = useRouter();
  const catalog = useCatalogLookups();
  const staff = useOptionalStaffSnapshot();
  const canManage = useStaffAccess().can("settings.manage");
  const { layout, canEdit, update } = usePageLayout(serviceOrderPage);
  const orderLayout = layout.lists?.[serviceOrderList];
  const [query, setQuery] = useState("");
  // One entry per row being saved, so a second row's change never clears the first row's.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const markBusy = (id: string, on: boolean) => setBusyIds((current) => { const next = new Set(current); if (on) next.add(id); else next.delete(id); return next; });
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Service | null>(null);
  const [removePending, setRemovePending] = useState(false);

  const ordered = useMemo(() => arrangeList(catalog.services, orderLayout).map(({ item }) => item), [catalog.services, orderLayout]);
  const searching = query.trim().length > 0;
  const shown = searching ? ordered.filter((service) => service.name.toLowerCase().includes(query.trim().toLowerCase())) : ordered;
  const dragging = canEdit && !searching && ordered.length > 1;

  function reorder(next: Service[]) {
    update(withListLayout(layout, serviceOrderList, { order: next.map((service) => service.id) }));
  }

  async function refresh() { await staff?.refresh(); }

  const actions: ServiceRowActions = {
    async onToggle(service, active) {
      markBusy(service.id, true);
      try {
        await staffMutation(`/api/staff/services/${service.id}`, "PATCH", { isActive: active });
        await refresh();
      } catch (error) {
        toastManager.add({ title: `Could not change this ${t.service}.`, description: message(error, "Try again."), type: "error" });
        // Someone may have saved it meanwhile; reload so the next try uses what is saved now.
        await refresh().catch(() => undefined);
      } finally {
        markBusy(service.id, false);
      }
    },
    async onVisibility(service, visibility) {
      markBusy(service.id, true);
      try {
        await staffMutation(`/api/staff/services/${service.id}`, "PATCH", { expectedVersion: service.version, basics: { visibility } });
        await refresh();
      } catch (error) {
        toastManager.add({ title: `Could not change this ${t.service}.`, description: message(error, "Try again."), type: "error" });
        // Someone may have saved it meanwhile; reload so the next try uses what is saved now.
        await refresh().catch(() => undefined);
      } finally {
        markBusy(service.id, false);
      }
    },
    async onCopyLink(service) {
      const url = serviceLink(window.location.origin, catalog.clinic.slug, service.slug ?? service.id);
      try {
        await navigator.clipboard.writeText(url);
        toastManager.add({ title: "Link copied.", description: service.name, type: "success" });
      } catch {
        toastManager.add({ title: "Could not copy the link.", description: url, type: "error" });
      }
    },
    async onDuplicate(service) {
      try {
        const copy = await staffMutation<{ serviceId: string }>(`/api/staff/services/${service.id}/duplicate`, "POST", {});
        await refresh();
        toastManager.add({ title: `${service.name} copied.`, description: "Opening the copy.", type: "success" });
        router.push(`/services/${copy.serviceId}`);
      } catch (error) {
        toastManager.add({ title: `Could not copy this ${t.service}.`, description: message(error, "Try again."), type: "error" });
      }
    },
    onDelete: setRemoving,
  };

  async function confirmDelete() {
    if (!removing) return;
    setRemovePending(true);
    try {
      await staffMutation(`/api/staff/services/${removing.id}`, "DELETE", undefined);
      await refresh();
      toastManager.add({ title: `${removing.name} deleted.`, type: "success" });
      setRemoving(null);
    } catch (error) {
      const inUse = error instanceof Error && "code" in error && error.code === "service_in_use";
      toastManager.add({
        title: `Could not delete this ${t.service}.`,
        description: inUse ? `This ${t.service} has ${t.appointments} or links, so it cannot be deleted. Turn it off instead.` : message(error, "Try again."),
        type: "error",
      });
      setRemoving(null);
    } finally {
      setRemovePending(false);
    }
  }

  const newButton = canManage ? (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden="true" />
      New {t.service}
    </Button>
  ) : null;
  const loading = !catalog.snapshot && Boolean(staff?.loading);
  const loadError = !catalog.snapshot && staff?.error ? staff.error : "";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="me-auto text-xl font-semibold">{t.Services}</h1>
        {newButton}
      </div>
      <InputGroup>
        <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
        <InputGroupInput type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${t.services}`} aria-label={`Search ${t.services}`} />
      </InputGroup>

      {loading ? (
        <div className="flex flex-col gap-2" role="status" aria-label={`Loading ${t.services}`}>
          {[0, 1, 2].map((key) => <Skeleton key={key} className="h-14 w-full" />)}
        </div>
      ) : loadError ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Could not load your {t.services}</EmptyTitle>
            <EmptyDescription>{loadError}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent><Button variant="outline" onClick={() => void refresh()}>Try again</Button></EmptyContent>
        </Empty>
      ) : ordered.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No {t.services} yet</EmptyTitle>
            <EmptyDescription>Add what {t.customers} can book, with how long it takes.</EmptyDescription>
          </EmptyHeader>
          {newButton ? <EmptyContent>{newButton}</EmptyContent> : null}
        </Empty>
      ) : shown.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No {t.services} match</EmptyTitle>
            <EmptyDescription>Nothing is called “{query.trim()}”.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent><Button variant="outline" onClick={() => setQuery("")}>Clear search</Button></EmptyContent>
        </Empty>
      ) : (
        <Sortable
          value={shown}
          onValueChange={reorder}
          getItemValue={(service) => service.id}
          className="flex flex-col divide-y overflow-hidden rounded-lg border bg-card"
          role="group"
          aria-label={`${t.Services}, in the order shown on your booking page`}
        >
          {shown.map((service) => (
            <ServiceRow
              key={service.id}
              service={service}
              previewHref={service.slug ? serviceLink("", catalog.clinic.slug, service.slug) : null}
              handle={dragging}
              canManage={canManage}
              busy={busyIds.has(service.id)}
              actions={actions}
            />
          ))}
        </Sortable>
      )}

      <NewServiceDialog open={creating} onOpenChange={setCreating} onCreated={(id) => router.push(`/services/${id}`)} refresh={refresh} />

      <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open && !removePending) setRemoving(null); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>This removes the {t.service} for good. If it has {t.appointments} or links, turn it off instead.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={removePending} render={<Button variant="ghost" />}>Keep it</AlertDialogClose>
            <Button variant="destructive" loading={removePending} onClick={() => void confirmDelete()}>Delete {t.service}</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function NewServiceDialog({ open, onOpenChange, onCreated, refresh }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (serviceId: string) => void;
  refresh: () => Promise<void>;
}) {
  const t = useTerms();
  const [name, setName] = useState("");
  const [minutes, setMinutes] = useState("30");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    const cleanName = name.trim();
    const length = Number(minutes);
    if (cleanName.length < 2) { setError("Give it a name of at least 2 letters."); return; }
    if (!Number.isInteger(length) || length < 5 || length > 480) { setError("Length must be 5 to 480 minutes."); return; }
    setPending(true);
    setError("");
    try {
      const created = await staffMutation<{ serviceId: string }>("/api/staff/services", "POST", { name: cleanName, description: cleanName, durationMinutes: length });
      await refresh();
      onOpenChange(false);
      setName("");
      onCreated(created.serviceId);
    } catch (failure) {
      setError(message(failure, "It could not be created."));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <Form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <DialogHeader>
            <DialogTitle>New {t.service}</DialogTitle>
            <DialogDescription>You can change everything else on the next screen.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" size="lg" />
            </Field>
            <Field>
              <FieldLabel>Length (minutes)</FieldLabel>
              <Input type="number" inputMode="numeric" min={5} max={480} value={minutes} onChange={(event) => setMinutes(event.target.value)} size="lg" />
            </Field>
            {error ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" loading={pending}>Create {t.service}</Button>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
}
