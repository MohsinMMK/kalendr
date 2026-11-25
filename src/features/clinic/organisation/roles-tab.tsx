"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Ellipsis, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { RichMenu, RichMenuContent, RichMenuItem, RichMenuTrigger } from "@/components/rich-menu";
import { SelectField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { useBusinessProfile } from "@/features/terms/business-profile-context";
import type { CustomRoleView } from "@/lib/enterprise-contracts";
import { assignableRoles, permissionGroupsFor, roleLabelsFor, rolePresets, type AssignableRole, type Permission } from "@/lib/permissions";

import { useStaffAccess } from "../staff-access";
import { useOrgChange, useRoles } from "./api";
import { errorText, QueryState, serverFieldErrors } from "./shared";

const formSchema = z.object({
  name: z.string().trim().min(2, "Enter at least 2 characters.").max(80, "Use 80 characters or fewer."),
  description: z.string().trim().max(240, "Use 240 characters or fewer."),
  baseRole: z.enum(assignableRoles),
});
type FormValues = z.infer<typeof formSchema>;

/** Settings > Organisation > Roles: roles shaped to the business, each a starting role plus the exact things it may do. */
export function RolesTab() {
  const query = useRoles();
  const change = useOrgChange({ stepUp: true });
  const [editing, setEditing] = useState<CustomRoleView | "new" | null>(null);
  const [removing, setRemoving] = useState<CustomRoleView | null>(null);
  const profile = useBusinessProfile();
  const labels = roleLabelsFor(profile);

  async function remove() {
    if (!removing) return;
    try {
      await change.mutateAsync({ path: `/api/staff/roles/${encodeURIComponent(removing.id)}`, method: "DELETE" });
      toastManager.add({ title: "Role deleted", type: "success" });
      setRemoving(null);
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not delete the role", description: errorText(cause, "Try again."), type: "error" });
      setRemoving(null);
    }
  }

  return (
    <QueryState query={query} label="Roles">
      {(roles) => (
        <div className="flex flex-col gap-4">
          {roles.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><ShieldCheck aria-hidden="true" /></EmptyMedia>
                <EmptyTitle>No custom roles yet</EmptyTitle>
                <EmptyDescription>Make a role such as &ldquo;Front desk&rdquo; that can book but can&apos;t see payments. People keep the built-in roles until you give them one.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent><Button type="button" size="lg" onClick={() => setEditing("new")}><Plus aria-hidden="true" /> New role</Button></EmptyContent>
            </Empty>
          ) : (
            <Frame>
              <FrameHeader className="flex-row items-start justify-between gap-3">
                <div className="min-w-0">
                  <FrameTitle>Roles</FrameTitle>
                  <FrameDescription>Give a role to someone from Sign-in and access on the Team page. Changing a role changes what everyone in it can do, from their next click.</FrameDescription>
                </div>
                <Button type="button" size="lg" onClick={() => setEditing("new")}><Plus aria-hidden="true" /> New role</Button>
              </FrameHeader>
              <FramePanel>
                <ul aria-label="Custom roles" className="flex flex-col divide-y">
                  {roles.map((role) => (
                    <li key={role.id} className="flex items-start justify-between gap-3 py-3">
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="truncate font-medium">{role.name}</span>
                        {role.description ? <span className="text-muted-foreground text-xs">{role.description}</span> : null}
                        <span className="flex flex-wrap gap-1">
                          <Badge variant="outline">Starts as {labels[role.baseRole]}</Badge>
                          <Badge variant="secondary">{role.permissions.length} {role.permissions.length === 1 ? "permission" : "permissions"}</Badge>
                          <Badge variant="secondary">{role.memberCount} {role.memberCount === 1 ? "person" : "people"}</Badge>
                        </span>
                      </div>
                      <RichMenu>
                        <RichMenuTrigger render={<Button type="button" variant="ghost" size="icon-lg" aria-label={`More for ${role.name}`} />}><Ellipsis aria-hidden="true" /></RichMenuTrigger>
                        <RichMenuContent>
                          <RichMenuItem icon={<Pencil aria-hidden="true" />} onClick={() => setEditing(role)}>Edit role</RichMenuItem>
                          <RichMenuItem destructive icon={<Trash2 aria-hidden="true" />} onClick={() => setRemoving(role)}>Delete role</RichMenuItem>
                        </RichMenuContent>
                      </RichMenu>
                    </li>
                  ))}
                </ul>
              </FramePanel>
            </Frame>
          )}
          <RoleDialog target={editing} onClose={() => setEditing(null)} />
          <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {removing?.name}?</AlertDialogTitle>
                <AlertDialogDescription>{removing && removing.memberCount > 0 ? `${removing.memberCount} ${removing.memberCount === 1 ? "person has" : "people have"} this role. Move them to another role first.` : "Nobody has this role, so nothing changes for anyone."}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button type="button" variant="ghost" size="lg" />}>Keep role</AlertDialogClose>
                <Button type="button" variant="destructive" size="lg" disabled={change.isPending || (removing?.memberCount ?? 0) > 0} onClick={() => void remove()}>Delete role</Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </div>
      )}
    </QueryState>
  );
}

function RoleDialog({ target, onClose }: { target: CustomRoleView | "new" | null; onClose: () => void }) {
  const change = useOrgChange({ stepUp: true });
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open && !change.isPending) onClose(); }}>
      <DialogPopup className="sm:max-w-xl">
        {target !== null ? <RoleForm existing={target === "new" ? null : target} change={change} onClose={onClose} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function RoleForm({ existing, change, onClose }: { existing: CustomRoleView | null; change: ReturnType<typeof useOrgChange>; onClose: () => void }) {
  const access = useStaffAccess();
  const profile = useBusinessProfile();
  const labels = roleLabelsFor(profile);
  const groups = permissionGroupsFor(profile);
  const [checked, setChecked] = useState<Set<Permission>>(() => new Set(existing ? existing.permissions : rolePresets.receptionist.filter((key) => access.can(key))));
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: existing ? { name: existing.name, description: existing.description ?? "", baseRole: existing.baseRole } : { name: "", description: "", baseRole: "receptionist" } });
  const { register, control, handleSubmit, setValue, setError, formState: { errors } } = form;

  const submit = handleSubmit(async (values) => {
    const body = { name: values.name, description: values.description || null, baseRole: values.baseRole, permissions: [...checked] };
    try {
      await change.mutateAsync(existing
        ? { path: `/api/staff/roles/${encodeURIComponent(existing.id)}`, method: "PATCH", body: { ...body, version: existing.version } }
        : { path: "/api/staff/roles", method: "POST", body });
      toastManager.add({ title: existing ? "Role saved" : "Role made", description: "People with it get the new access from their next click.", type: "success" });
      onClose();
    } catch (cause: unknown) {
      const fields = serverFieldErrors(cause);
      if (fields.name) setError("name", { message: fields.name });
    }
  });

  const base = useWatch({ control, name: "baseRole" });
  const formError = change.isError && Object.keys(serverFieldErrors(change.error)).length === 0 ? errorText(change.error, "The role could not be saved.") : "";

  return (
        <form onSubmit={(event) => void submit(event)} noValidate className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>{existing ? `Edit ${existing.name}` : "New role"}</DialogTitle>
            <DialogDescription>Start from a built-in role, then tick exactly what this role may do.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-5">
            {formError ? <Alert variant="error"><AlertDescription>{formError}</AlertDescription></Alert> : null}
            <TextField label="Name" autoComplete="off" placeholder="Front desk" error={errors.name?.message} {...register("name")} />
            <TextField label="What it is for" optional autoComplete="off" error={errors.description?.message} {...register("description")} />
            <SelectField
              label="Starts as"
              hint="Decides the second-factor rules for this role, and what &lsquo;Reset&rsquo; goes back to."
              value={base}
              onValueChange={(value) => {
                setValue("baseRole", value as AssignableRole);
                setChecked(new Set(rolePresets[value as AssignableRole].filter((key) => access.can(key))));
              }}
              options={assignableRoles.map((role) => ({ value: role, label: labels[role] }))}
            />
            {groups.map((group) => (
              <fieldset key={group.title} className="flex flex-col gap-1">
                <legend className="mb-1 text-xs font-medium text-muted-foreground">{group.title}</legend>
                <ul className="flex flex-col divide-y rounded-lg border">
                  {group.items.map((item) => {
                    const id = `role-permission-${item.key.replace(".", "-")}`;
                    const held = access.can(item.key);
                    const on = checked.has(item.key);
                    return (
                      <li key={item.key} className="flex min-h-11 items-start gap-3 p-3">
                        <Checkbox id={id} aria-labelledby={`${id}-label`} className="mt-0.5" checked={on} disabled={!held && !on} onCheckedChange={(next: boolean) => setChecked((current) => {
                          const copy = new Set(current);
                          if (next) copy.add(item.key); else copy.delete(item.key);
                          return copy;
                        })} />
                        <div className="min-w-0 flex-1">
                          <label id={`${id}-label`} htmlFor={id} className="text-sm font-medium">{item.label}</label>
                          <p className="text-muted-foreground text-xs">{!held && !on ? "You don't have this permission yourself, so you can't give it." : item.description}</p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            ))}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" size="lg" onClick={onClose} disabled={change.isPending}>Cancel</Button>
            <Button type="submit" size="lg" disabled={change.isPending}>{change.isPending ? <Spinner aria-hidden="true" /> : null}{existing ? "Save role" : "Make role"}</Button>
          </DialogFooter>
        </form>
  );
}
