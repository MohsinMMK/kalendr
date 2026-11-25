"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { CalendarClock, Ellipsis, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { RichMenu, RichMenuContent, RichMenuItem, RichMenuTrigger } from "@/components/rich-menu";
import { SelectField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { useBusinessProfile, useTerms } from "@/features/terms/business-profile-context";
import type { ScimTokenView } from "@/lib/enterprise-contracts";
import { roleLabelsFor } from "@/lib/permissions";

import { useCatalogLookups } from "../clinic-catalog";
import { TimeOffReassignDialog } from "../time-off-reassign-dialog";
import { useOrgChange, useReassignments, useScimTokens, type ReassignmentNeeded } from "./api";
import { errorText, formatDay, formatStamp, QueryState, SecretRevealDialog, serverFieldErrors } from "./shared";

const roles = ["receptionist", "practitioner", "billing", "read_only"] as const;
const formSchema = z.object({ name: z.string().trim().min(2, "Enter at least 2 characters.").max(80, "Use 80 characters or fewer."), defaultRole: z.enum(roles) });
type FormValues = z.infer<typeof formSchema>;

/** Settings > Organisation > Provisioning: lets the company's directory add, change and deactivate people. */
export function ProvisioningTab() {
  const query = useScimTokens();
  const reassignments = useReassignments();
  const change = useOrgChange({ stepUp: true });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ScimTokenView | null>(null);
  const [revoking, setRevoking] = useState<ScimTokenView | null>(null);
  const [reassigning, setReassigning] = useState<ReassignmentNeeded | null>(null);
  const catalog = useCatalogLookups();
  const labels = roleLabelsFor(useBusinessProfile());
  const t = useTerms();
  const origin = useSyncExternalStore(() => () => undefined, () => window.location.origin, () => "");

  async function revoke() {
    if (!revoking) return;
    try {
      await change.mutateAsync({ path: `/api/staff/org/scim/tokens/${encodeURIComponent(revoking.id)}`, method: "DELETE" });
      toastManager.add({ title: "Token revoked", description: "The directory is refused from now on.", type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not revoke the token", description: errorText(cause, "Try again."), type: "error" });
    } finally {
      setRevoking(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <QueryState query={query} label="Directory sync">
        {(tokens) => {
          const active = tokens.filter((token) => !token.revokedAt);
          const past = tokens.filter((token) => token.revokedAt);
          return (
            <>
              {tokens.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><KeyRound aria-hidden="true" /></EmptyMedia>
                    <EmptyTitle>Directory sync is off</EmptyTitle>
                    <EmptyDescription>Make a token, paste it into Okta, Azure AD or Google Workspace, and your directory adds, changes and deactivates people here. Nothing it does ever deletes a booking.</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent><Button type="button" size="lg" onClick={() => setCreating(true)}><Plus aria-hidden="true" /> Make a token</Button></EmptyContent>
                </Empty>
              ) : (
                <Frame>
                  <FrameHeader className="flex-row items-start justify-between gap-3">
                    <div className="min-w-0">
                      <FrameTitle>Directory tokens</FrameTitle>
                      <FrameDescription>{active.length} active. A token is shown only when you make it.</FrameDescription>
                    </div>
                    <Button type="button" size="lg" onClick={() => setCreating(true)}><Plus aria-hidden="true" /> Make a token</Button>
                  </FrameHeader>
                  <FramePanel>
                    <ul aria-label="Directory tokens" className="flex flex-col divide-y">
                      {[...active, ...past].map((token) => (
                        <li key={token.id} className="flex items-start justify-between gap-3 py-3">
                          <div className="flex min-w-0 flex-col gap-1">
                            <span className="truncate font-medium">{token.name}</span>
                            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
                              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{token.prefix}…</code>
                              <span>New people join as {labels[token.defaultRole]}</span>
                            </span>
                            <span className="text-muted-foreground text-xs">Last used {token.lastUsedAt ? formatStamp(token.lastUsedAt) : "never"} · made {formatDay(token.createdAt)}</span>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {token.revokedAt ? <Badge variant="secondary">Revoked</Badge> : <Badge variant="success">Active</Badge>}
                            {!token.revokedAt ? (
                              <RichMenu>
                                <RichMenuTrigger render={<Button type="button" variant="ghost" size="icon-lg" aria-label={`More for ${token.name}`} />}><Ellipsis aria-hidden="true" /></RichMenuTrigger>
                                <RichMenuContent>
                                  <RichMenuItem destructive icon={<Trash2 aria-hidden="true" />} onClick={() => setRevoking(token)}>Revoke token</RichMenuItem>
                                </RichMenuContent>
                              </RichMenu>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </FramePanel>
                  <FramePanel className="flex flex-col gap-2">
                    <label htmlFor="scim-url" className="font-medium text-xs">Address to give your directory</label>
                    <Input id="scim-url" readOnly size="lg" value={origin ? `${origin}/api/scim/v2` : ""} className="font-mono" onFocus={(event) => event.currentTarget.select()} />
                    <p className="text-muted-foreground text-xs">Use it as the SCIM base address, with the token as the bearer token. Group names become teams. People must have an email on a proved domain.</p>
                  </FramePanel>
                </Frame>
              )}
              <CreateTokenDialog open={creating} onClose={() => setCreating(false)} onCreated={(token) => { setCreating(false); setCreated(token); }} />
              <SecretRevealDialog open={created !== null} title="Copy your directory token" description={created ? `${created.name} is ready to paste into your directory.` : ""} label="Directory token" secret={created?.token ?? ""} onDone={() => setCreated(null)} />
              <AlertDialog open={revoking !== null} onOpenChange={(open) => { if (!open) setRevoking(null); }}>
                <AlertDialogPopup>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Revoke {revoking?.name}?</AlertDialogTitle>
                    <AlertDialogDescription>Your directory is refused at once and stops adding or removing people. Nobody who is already here is changed.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogClose render={<Button type="button" variant="ghost" size="lg" />}>Keep token</AlertDialogClose>
                    <Button type="button" variant="destructive" size="lg" disabled={change.isPending} onClick={() => void revoke()}>Revoke token</Button>
                  </AlertDialogFooter>
                </AlertDialogPopup>
              </AlertDialog>
            </>
          );
        }}
      </QueryState>

      <QueryState query={reassignments} label="Bookings to move">
        {(needed) => needed.length === 0 ? null : (
          <Frame>
            <FrameHeader>
              <FrameTitle>Bookings that need someone new</FrameTitle>
              <FrameDescription>These {t.practitioners} were deactivated. Their calendars are closed, and their {t.visits} stay until you move them.</FrameDescription>
            </FrameHeader>
            <FramePanel>
              <ul aria-label="People with bookings to move" className="flex flex-col divide-y">
                {needed.map((entry) => (
                  <li key={entry.timeOffId} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-sm">{entry.name}</p>
                      <p className="text-muted-foreground text-xs">{entry.bookings} {entry.bookings === 1 ? t.visit : t.visits} ahead</p>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={() => setReassigning(entry)}><CalendarClock aria-hidden="true" /> Move them<span className="sr-only"> for {entry.name}</span></Button>
                  </li>
                ))}
              </ul>
            </FramePanel>
          </Frame>
        )}
      </QueryState>
      {reassigning ? (
        <TimeOffReassignDialog
          open
          onOpenChange={(next) => { if (!next) { setReassigning(null); void reassignments.refetch(); } }}
          timeOffId={reassigning.timeOffId}
          people={catalog.practitioners.filter((person) => person.id !== reassigning.practitionerId && person.isActive).map((person) => ({ id: person.id, name: person.name }))}
          locale={catalog.clinic.locale}
          zone={catalog.clinic.timezone}
        />
      ) : null}
      {reassignments.isError ? <Alert variant="warning"><AlertTitle>Could not check for bookings to move</AlertTitle><AlertDescription><Button type="button" variant="outline" size="sm" onClick={() => void reassignments.refetch()}><RefreshCw aria-hidden="true" /> Retry</Button></AlertDescription></Alert> : null}
    </div>
  );
}

function CreateTokenDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (token: ScimTokenView) => void }) {
  const change = useOrgChange<ScimTokenView>({ stepUp: true });
  const labels = roleLabelsFor(useBusinessProfile());
  const { register, control, handleSubmit, reset, setError, formState: { errors } } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: { name: "", defaultRole: "read_only" } });
  useEffect(() => { if (open) { reset({ name: "", defaultRole: "read_only" }); change.reset(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- reset only when the dialog opens
  const submit = handleSubmit(async (values) => {
    try {
      onCreated(await change.mutateAsync({ path: "/api/staff/org/scim/tokens", method: "POST", body: values }));
    } catch (cause: unknown) {
      const fields = serverFieldErrors(cause);
      if (fields.name) setError("name", { message: fields.name });
    }
  });
  const formError = change.isError && Object.keys(serverFieldErrors(change.error)).length === 0 ? errorText(change.error, "The token could not be made.") : "";
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !change.isPending) onClose(); }}>
      <DialogPopup>
        <form onSubmit={(event) => void submit(event)} noValidate className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>Make a directory token</DialogTitle>
            <DialogDescription>One token for each directory tool you connect.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-5">
            {formError ? <Alert variant="error"><AlertDescription>{formError}</AlertDescription></Alert> : null}
            <TextField label="Name" autoComplete="off" placeholder="Okta" hint="Only you see this." error={errors.name?.message} {...register("name")} />
            <Controller control={control} name="defaultRole" render={({ field }) => (
              <SelectField label="New people join as" hint="You can change anyone's role later from Sign-in and access on the Team page." value={field.value} onValueChange={(value) => field.onChange(value)} options={roles.map((role) => ({ value: role, label: labels[role] }))} />
            )} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" size="lg" onClick={onClose} disabled={change.isPending}>Cancel</Button>
            <Button type="submit" size="lg" disabled={change.isPending}>{change.isPending ? <Spinner aria-hidden="true" /> : null}Make token</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
