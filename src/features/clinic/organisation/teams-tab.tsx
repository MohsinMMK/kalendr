"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Building, Ellipsis, ExternalLink, EyeOff, Pencil, Plus, Trash2, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { RichMenu, RichMenuContent, RichMenuItem, RichMenuTrigger } from "@/components/rich-menu";
import { SelectField, TextareaField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import type { TeamView } from "@/lib/enterprise-contracts";

import { useCatalogLookups } from "../clinic-catalog";
import { useOptionalStaffSnapshot } from "../staff-snapshot-provider";
import { useOrgChange, useTeams } from "./api";
import { errorText, QueryState, serverFieldErrors } from "./shared";
import { ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";

const none = "";

const formSchema = z.object({
  name: z.string().trim().min(2, "Enter at least 2 characters.").max(120, "Use 120 characters or fewer."),
  description: z.string().trim().max(600, "Use 600 characters or fewer."),
  parentTeamId: z.string(),
  locationId: z.string(),
  isPrivate: z.boolean(),
  membershipIds: z.array(z.string()),
});
type FormValues = z.infer<typeof formSchema>;

/** Settings > Organisation > Teams: departments with their own booking page, nested under branches or on their own. */
export function TeamsTab() {
  const query = useTeams();
  const change = useOrgChange();
  const catalog = useCatalogLookups();
  const [editing, setEditing] = useState<TeamView | "new" | null>(null);
  const [removing, setRemoving] = useState<TeamView | null>(null);
  const t = useTerms();

  async function remove() {
    if (!removing) return;
    try {
      await change.mutateAsync({ path: `/api/staff/teams/${encodeURIComponent(removing.id)}`, method: "DELETE" });
      toastManager.add({ title: "Team deleted", description: "Its page is gone. Nobody lost access to anything else.", type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not delete the team", description: errorText(cause, "Try again."), type: "error" });
    } finally {
      setRemoving(null);
    }
  }

  return (
    <QueryState query={query} label="Teams">
      {(teams) => {
        const nameOf = new Map(teams.map((team) => [team.id, team.name]));
        return (
          <div className="flex flex-col gap-4">
            {teams.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon"><UsersRound aria-hidden="true" /></EmptyMedia>
                  <EmptyTitle>No teams yet</EmptyTitle>
                  <EmptyDescription>A team is a department, such as Dermatology. It gets its own page that lists its services and people, and it can be private so the page books but doesn&apos;t name anyone.</EmptyDescription>
                </EmptyHeader>
                <EmptyContent><Button type="button" size="lg" onClick={() => setEditing("new")}><Plus aria-hidden="true" /> New team</Button></EmptyContent>
              </Empty>
            ) : (
              <Frame>
                <FrameHeader className="flex-row items-start justify-between gap-3">
                  <div className="min-w-0">
                    <FrameTitle>Teams</FrameTitle>
                    <FrameDescription>{teams.length} {teams.length === 1 ? "team" : "teams"}. Each has a page at its own address.</FrameDescription>
                  </div>
                  <Button type="button" size="lg" onClick={() => setEditing("new")}><Plus aria-hidden="true" /> New team</Button>
                </FrameHeader>
                <FramePanel>
                  <ul aria-label="Teams" className="flex flex-col divide-y">
                    {teams.map((team) => (
                      <li key={team.id} className="flex items-start justify-between gap-3 py-3">
                        <div className="flex min-w-0 flex-col gap-1">
                          <span className="truncate font-medium">{team.name}</span>
                          <span className="flex flex-wrap gap-1">
                            <Badge variant="secondary">{team.memberCount} {team.memberCount === 1 ? "person" : "people"}</Badge>
                            {team.parentTeamId ? <Badge variant="outline">Under {nameOf.get(team.parentTeamId) ?? "another team"}</Badge> : null}
                            {team.locationId ? <Badge variant="outline"><Building aria-hidden="true" /> {catalog.locationName(team.locationId)}</Badge> : null}
                            {team.isPrivate ? <Badge variant="warning"><EyeOff aria-hidden="true" /> Private</Badge> : null}
                            {!team.isActive ? <Badge variant="secondary">Page off</Badge> : null}
                          </span>
                        </div>
                        <RichMenu>
                          <RichMenuTrigger render={<Button type="button" variant="ghost" size="icon-lg" aria-label={`More for ${team.name}`} />}><Ellipsis aria-hidden="true" /></RichMenuTrigger>
                          <RichMenuContent>
                            <RichMenuItem icon={<Pencil aria-hidden="true" />} onClick={() => setEditing(team)}>Edit team</RichMenuItem>
                            <RichMenuItem icon={<ExternalLink aria-hidden="true" />} onClick={() => window.open(`/b/${catalog.clinic.slug}/t/${team.slug}`, "_blank", "noopener,noreferrer")}>Open its page</RichMenuItem>
                            <RichMenuItem destructive icon={<Trash2 aria-hidden="true" />} onClick={() => setRemoving(team)}>Delete team</RichMenuItem>
                          </RichMenuContent>
                        </RichMenu>
                      </li>
                    ))}
                  </ul>
                </FramePanel>
              </Frame>
            )}
            <TeamDialog target={editing} teams={teams} onClose={() => setEditing(null)} />
            <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {removing?.name}?</AlertDialogTitle>
                  <AlertDialogDescription>Its page stops working. The people in it keep their access, and nothing booked changes. {t.Customers} who saved the page will see &ldquo;page unavailable&rdquo;.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose render={<Button type="button" variant="ghost" size="lg" />}>Keep team</AlertDialogClose>
                  <Button type="button" variant="destructive" size="lg" disabled={change.isPending} onClick={() => void remove()}>Delete team</Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
          </div>
        );
      }}
    </QueryState>
  );
}

function TeamDialog({ target, teams, onClose }: { target: TeamView | "new" | null; teams: TeamView[]; onClose: () => void }) {
  const change = useOrgChange();
  const catalog = useCatalogLookups();
  const snapshot = useOptionalStaffSnapshot()?.snapshot ?? null;
  const people = snapshot?.team.filter((member) => member.isActive) ?? [];
  const existing = target !== null && target !== "new" ? target : null;
  const { register, control, handleSubmit, reset, setError, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", description: "", parentTeamId: none, locationId: none, isPrivate: false, membershipIds: [] },
  });

  useEffect(() => {
    if (target === null) return;
    reset(existing
      ? { name: existing.name, description: existing.description ?? "", parentTeamId: existing.parentTeamId ?? none, locationId: existing.locationId ?? none, isPrivate: existing.isPrivate, membershipIds: existing.membershipIds }
      : { name: "", description: "", parentTeamId: none, locationId: none, isPrivate: false, membershipIds: [] });
    change.reset();
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps -- reset only when the dialog opens

  const submit = handleSubmit(async (values) => {
    const body = { name: values.name, description: values.description || null, parentTeamId: values.parentTeamId || null, locationId: values.locationId || null, isPrivate: values.isPrivate, membershipIds: values.membershipIds };
    try {
      await change.mutateAsync(existing
        ? { path: `/api/staff/teams/${encodeURIComponent(existing.id)}`, method: "PATCH", body: { ...body, version: existing.version } }
        : { path: "/api/staff/teams", method: "POST", body });
      toastManager.add({ title: existing ? "Team saved" : "Team made", type: "success" });
      onClose();
    } catch (cause: unknown) {
      const fields = serverFieldErrors(cause);
      if (fields.name) setError("name", { message: fields.name });
    }
  });

  const parents = teams.filter((team) => team.id !== existing?.id);
  const formError = change.isError && Object.keys(serverFieldErrors(change.error)).length === 0 ? errorText(change.error, "The team could not be saved.") : "";

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open && !change.isPending) onClose(); }}>
      <DialogPopup className="sm:max-w-xl">
        <form onSubmit={(event) => void submit(event)} noValidate className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>{existing ? `Edit ${existing.name}` : "New team"}</DialogTitle>
            <DialogDescription>A team page lists what it offers and, unless it is private, who is in it.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-5">
            {formError ? <Alert variant="error"><AlertDescription>{formError}</AlertDescription></Alert> : null}
            <TextField label="Name" autoComplete="off" placeholder="Dermatology" error={errors.name?.message} {...register("name")} />
            <TextareaField label="About the team" optional rows={3} hint="Shown at the top of its page." error={errors.description?.message} {...register("description")} />
            <Controller control={control} name="parentTeamId" render={({ field }) => (
              <SelectField label="Sits under" optional hint="Leave empty for a team of its own." value={field.value} onValueChange={field.onChange} options={[{ value: none, label: "Nothing, it stands alone" }, ...parents.map((team) => ({ value: team.id, label: team.name }))]} />
            )} />
            {catalog.locations.length > 1 ? (
              <Controller control={control} name="locationId" render={({ field }) => (
                <SelectField label="Branch" optional value={field.value} onValueChange={field.onChange} options={[{ value: none, label: "Any branch" }, ...catalog.locations.map((location) => ({ value: location.id, label: location.name }))]} />
              )} />
            ) : null}
            <Controller control={control} name="isPrivate" render={({ field }) => (
              <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
                <div className="min-w-0">
                  <label htmlFor="team-private" className="text-sm font-medium">Private</label>
                  <p className="text-muted-foreground text-xs">The page still takes bookings, but doesn&apos;t name the people in the team.</p>
                </div>
                <Switch id="team-private" checked={field.value} onCheckedChange={field.onChange} />
              </div>
            )} />
            <Controller control={control} name="membershipIds" render={({ field }) => (
              <fieldset className="flex flex-col gap-1">
                <legend className="mb-1 text-sm font-medium">People</legend>
                {people.length === 0 ? <p className="text-muted-foreground text-xs">Your team list opens when you can manage sign-ins on the Team page.</p> : (
                  <ScrollAreaPrimitive.Root className="rounded-lg border"><ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className="max-h-60 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"><ScrollAreaPrimitive.Content style={{ minWidth: 0 }}><ul className="flex flex-col divide-y">
                    {people.map((person) => {
                      const id = `team-person-${person.membershipId}`;
                      return (
                        <li key={person.membershipId} className="flex min-h-11 items-center gap-3 px-3 py-2">
                          <Checkbox id={id} aria-labelledby={`${id}-label`} checked={field.value.includes(person.membershipId)} onCheckedChange={(checked: boolean) => field.onChange(checked ? [...field.value, person.membershipId] : field.value.filter((value) => value !== person.membershipId))} />
                          <label id={`${id}-label`} htmlFor={id} className="min-w-0 flex-1 truncate text-sm">{person.name}{person.practitionerId ? "" : <span className="text-muted-foreground"> · not on a calendar</span>}</label>
                        </li>
                      );
                    })}
                  </ul></ScrollAreaPrimitive.Content></ScrollAreaPrimitive.Viewport><ScrollBar orientation="vertical" /></ScrollAreaPrimitive.Root>
                )}
              </fieldset>
            )} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" size="lg" onClick={onClose} disabled={change.isPending}>Cancel</Button>
            <Button type="submit" size="lg" disabled={change.isPending}>{change.isPending ? <Spinner aria-hidden="true" /> : null}{existing ? "Save team" : "Make team"}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
