"use client";

import { useState } from "react";
import Link from "next/link";
import { BadgeCheck, CalendarCheck, Crown, MapPin, Ellipsis, KeyRound, Link2, LogOut, MailPlus, MailX, ShieldCheck, Unlink, UserMinus, UserPlus, UserRoundCheck, UserRoundX, UsersRound } from "lucide-react";

import { SelectField, TextField } from "@/components/form-fields";
import { PersonAvatar } from "@/components/person-avatar";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toastManager } from "@/components/ui/toast";
import { useBusinessProfile, useTerms } from "@/features/terms/business-profile-context";
import {
  permissionGroups,
  permissionGroupsFor,
  roleDescriptionsFor,
  roleLabelsFor,
  rolePresets,
  type AssignableRole,
  type Permission,
  type PermissionOverrides,
  type StaffRole,
} from "@/lib/permissions";
import { locationLimitLabel, normaliseLocationIds, sameLocationIds } from "@/lib/member-locations";
import { inviteExpiry, lastSignInLabel } from "@/lib/staff-invite-state";
import type { StaffTeamMember } from "@/lib/staff-snapshot";
import type { AccountLink } from "@/server/staff-invites";

import { AccessLinkNotice } from "./access-link-notice";
import { MemberActionDialogs, type MemberAction } from "./team-member-actions";
import { MemberEmailDialog } from "./member-email-dialog";
import { MemberLocationsField, useMemberLocationChoices } from "./member-locations-field";
import { TeamShareCard } from "./team-share-card";
import { useCatalogLookups } from "./clinic-catalog";
import { useStaffAccess } from "./staff-access";
import { staffMutation, useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { useRoles } from "./organisation/api";
import { useStepUp } from "./step-up-dialog";

type InviteRole = "admin" | "receptionist" | "billing" | "read_only";

const inviteRoles: InviteRole[] = ["receptionist", "billing", "read_only", "admin"];

/** Role names and descriptions in this business's words. */
function useRoleWords() {
  const profile = useBusinessProfile();
  const roleLabels = roleLabelsFor(profile);
  const roleDescriptions = roleDescriptionsFor(profile);
  return {
    roleLabels,
    roleOption: (role: StaffRole) => ({ value: role, label: `${roleLabels[role]} — ${roleDescriptions[role]}` }),
  };
}

function overrideCount(member: StaffTeamMember): number {
  return Object.keys(member.permissionOverrides ?? {}).length;
}

export function TeamWorkspace({ onBack }: { onBack?: () => void }) {
  const catalog = useCatalogLookups();
  const staff = useOptionalStaffSnapshot();
  const access = useStaffAccess();
  const team = staff?.snapshot?.team ?? [];
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editing, setEditing] = useState<StaffTeamMember | null>(null);
  const [titling, setTitling] = useState<StaffTeamMember | null>(null);
  const [emailing, setEmailing] = useState<StaffTeamMember | null>(null);
  const [deactivating, setDeactivating] = useState<StaffTeamMember | null>(null);
  const [memberAction, setMemberAction] = useState<MemberAction | null>(null);
  const [link, setLink] = useState<{ member: string; link: AccountLink; kind: "invite" | "reset" } | null>(null);
  const [pendingId, setPendingId] = useState("");
  const [message, setMessage] = useState("");
  const canManage = access.can("team.manage");
  const t = useTerms();
  const { roleLabels } = useRoleWords();
  const { runWithStepUp } = useStepUp();

  if (!catalog.database) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><UsersRound aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>Team accounts need the {t.business} database</EmptyTitle>
          <EmptyDescription>Sign-ins are not created in the browser preview. {t.Providers} can be added and edited on the {t.Providers} page.</EmptyDescription>
        </EmptyHeader>
        {onBack ? <EmptyContent><Button variant="outline" onClick={onBack}>Back to settings</Button></EmptyContent> : null}
      </Empty>
    );
  }

  /** "Tolichowki only" for someone limited to some locations; nothing for everyone else. */
  function locationLimit(member: StaffTeamMember): string | null {
    return locationLimitLabel(member.locationIds, catalog.locationName);
  }

  /** The owner row, your own row and (unless you are the owner) admin rows can't be changed here. */
  function canChange(member: StaffTeamMember): boolean {
    if (!canManage || member.role === "owner" || member.userId === access.userId) return false;
    return member.role !== "admin" || access.role === "owner";
  }

  async function sendLink(member: StaffTeamMember) {
    setPendingId(member.membershipId);
    setMessage("");
    try {
      const result = await runWithStepUp(() => staffMutation<AccountLink & { kind: "invite" | "reset" }>(`/api/staff/team/members/${member.membershipId}/access-link`, "POST", {}));
      setLink({ member: member.name, link: result, kind: result.kind });
      await staff?.refresh();
    } catch (cause: unknown) {
      setMessage(cause instanceof Error ? cause.message : "The link could not be sent.");
    } finally {
      setPendingId("");
    }
  }

  async function setActive(member: StaffTeamMember, isActive: boolean) {
    setPendingId(member.membershipId);
    setMessage("");
    try {
      if (member.practitionerId) {
        await staffMutation(`/api/staff/team/practitioners/${member.practitionerId}`, "PATCH", { isActive });
      } else {
        await staffMutation(`/api/staff/team/members/${member.membershipId}`, "PATCH", { isActive });
      }
      await staff?.refresh();
      toastManager.add({
        title: isActive ? `${member.name} can sign in again` : `${member.name} has been deactivated`,
        description: isActive ? "Their role and permissions are as they were." : "They were signed out on every device.",
        type: "success",
      });
      setDeactivating(null);
    } catch (cause: unknown) {
      setMessage(cause instanceof Error ? cause.message : "The change could not be saved.");
    } finally {
      setPendingId("");
    }
  }

  const active = team.filter((member) => member.isActive).length;

  return (
    <div className="flex flex-col gap-4">
      {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
      {link ? (
        <div className="flex flex-col gap-2">
          <AccessLinkNotice link={link.link} name={link.member} kind={link.kind} />
          <Button variant="ghost" size="sm" className="self-end" onClick={() => setLink(null)}>Done</Button>
        </div>
      ) : null}
      <Frame>
        <FrameHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 basis-64">
            <FrameTitle>Team</FrameTitle>
            <FrameDescription>
              {active} {active === 1 ? "person" : "people"} can sign in. Each role starts with its own permissions, and you can switch single ones on or off per person.
            </FrameDescription>
          </div>
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" render={<Link href="/doctors" />}><UserPlus aria-hidden="true" /> Add {t.provider}</Button>
              <Button size="sm" onClick={() => setInviteOpen(true)}><MailPlus aria-hidden="true" /> Invite staff</Button>
            </div>
          ) : null}
        </FrameHeader>
        <FramePanel className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead>
                <TableHead className="max-sm:hidden">Access</TableHead>
                <TableHead className="max-sm:hidden">Status</TableHead>
                <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {team.map((member) => {
                const changes = overrideCount(member);
                const status = <MemberStatus member={member} />;
                const roleBadges = (
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge variant="outline">{member.customRoleName ?? roleLabels[member.role]}</Badge>
                    {changes ? <Badge variant="secondary">{changes} {changes === 1 ? "change" : "changes"}</Badge> : null}
                    {member.practitionerId ? <Badge variant="secondary"><CalendarCheck aria-hidden="true" /> On calendar</Badge> : null}
                    {locationLimit(member) ? <Badge variant="secondary"><MapPin aria-hidden="true" /> {locationLimit(member)}</Badge> : null}
                    {member.worksElsewhere ? <Badge variant="outline">Also works elsewhere</Badge> : null}
                    {member.secondFactor === true ? <Badge variant="secondary"><ShieldCheck aria-hidden="true" /> Second factor on</Badge> : null}
                    {member.secondFactor === false && (member.role === "owner" || member.role === "admin") ? <Badge variant="warning">No second factor</Badge> : null}
                  </div>
                );
                return (
                  <TableRow key={member.membershipId}>
                    <TableCell className="whitespace-normal">
                      <div className="flex min-w-0 items-center gap-3">
                        <PersonAvatar name={member.name} />
                        <div className="min-w-0">
                          <p className="font-medium">
                            {member.name}
                            {member.userId === access.userId ? <span className="font-normal text-muted-foreground"> (you)</span> : null}
                          </p>
                          {member.jobTitle ? <p className="text-sm text-muted-foreground">{member.jobTitle}</p> : null}
                          <p className="text-xs break-all text-muted-foreground">{member.email}</p>
                          {member.lastSignInAt !== undefined && !member.invitePending ? <p className="text-xs text-muted-foreground">{lastSignInLabel(member.lastSignInAt)}</p> : null}
                          <div className="mt-1 flex flex-wrap gap-1 sm:hidden">{roleBadges}{status}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="max-sm:hidden">{roleBadges}</TableCell>
                    <TableCell className="max-sm:hidden">{status}</TableCell>
                    <TableCell className="text-end">
                      {canChange(member) ? (
                        <Menu>
                          <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${member.name}`} disabled={pendingId === member.membershipId} />}>
                            <Ellipsis aria-hidden="true" />
                          </MenuTrigger>
                          <MenuPopup align="end">
                            <MenuItem onClick={() => setEditing(member)} disabled={!member.isActive}>
                              <ShieldCheck aria-hidden="true" /> Edit access
                            </MenuItem>
                            <MenuItem onClick={() => setTitling(member)}>
                              <BadgeCheck aria-hidden="true" /> Job title
                            </MenuItem>
                            <MenuItem onClick={() => setEmailing(member)} disabled={!member.isActive || member.worksElsewhere}><MailPlus aria-hidden="true" /> Change email</MenuItem>
                            <MenuItem onClick={() => void sendLink(member)} disabled={!member.isActive || member.worksElsewhere}>
                              {member.invitePending ? <MailPlus aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
                              {member.invitePending ? "Resend invite" : "Send password reset"}
                            </MenuItem>
                            {member.practitionerId ? (
                              <MenuItem onClick={() => setMemberAction({ kind: "unlink", member })}>
                                <Unlink aria-hidden="true" /> Unlink {t.provider} profile
                              </MenuItem>
                            ) : (
                              <MenuItem onClick={() => setMemberAction({ kind: "link", member })} disabled={!member.isActive}>
                                <Link2 aria-hidden="true" /> Link a {t.provider} profile
                              </MenuItem>
                            )}
                            {!member.invitePending ? (
                              <MenuItem onClick={() => setMemberAction({ kind: "sign_out", member })}>
                                <LogOut aria-hidden="true" /> Sign out everywhere
                              </MenuItem>
                            ) : null}
                            {access.role === "owner" && member.isActive ? (
                              <MenuItem onClick={() => setMemberAction({ kind: "transfer", member })}>
                                <Crown aria-hidden="true" /> Make owner
                              </MenuItem>
                            ) : null}
                            <MenuSeparator />
                            {member.isActive ? (
                              <MenuItem variant="destructive" onClick={() => setDeactivating(member)}>
                                <UserMinus aria-hidden="true" /> Deactivate
                              </MenuItem>
                            ) : (
                              <MenuItem onClick={() => void setActive(member, true)}>
                                <UserRoundCheck aria-hidden="true" /> Reactivate
                              </MenuItem>
                            )}
                            {member.invitePending ? (
                              <MenuItem variant="destructive" onClick={() => setMemberAction({ kind: "cancel_invite", member })}>
                                <MailX aria-hidden="true" /> Cancel invite
                              </MenuItem>
                            ) : null}
                            <MenuItem variant="destructive" onClick={() => setMemberAction({ kind: "remove", member })}>
                              <UserRoundX aria-hidden="true" /> Remove from team
                            </MenuItem>
                          </MenuPopup>
                        </Menu>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </FramePanel>
      </Frame>
      <TeamShareCard />
      {onBack ? <Button variant="outline" className="self-start" onClick={onBack}>Back to settings</Button> : null}

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        ownerActing={access.role === "owner"}
        onInvited={() => void staff?.refresh()}
      />
      <MemberEmailDialog member={emailing} onClose={() => setEmailing(null)} onSaved={() => staff?.refresh()} />
      <JobTitleDialog
        member={titling}
        onClose={() => setTitling(null)}
        onSaved={async (member) => {
          await staff?.refresh();
          toastManager.add({ title: `${member.name}'s job title was saved`, type: "success" });
        }}
      />
      <EditAccessDialog
        member={editing}
        onClose={() => setEditing(null)}
        ownerActing={access.role === "owner"}
        actorPermissions={access.permissions}
        onSaved={async (member) => {
          await staff?.refresh();
          toastManager.add({ title: `${member.name}'s access was updated`, description: "It applies from their next click. No need to sign out.", type: "success" });
        }}
      />
      <MemberActionDialogs
        action={memberAction}
        onClose={() => setMemberAction(null)}
        onDone={async (done) => {
          await staff?.refresh();
          toastManager.add({ title: done.title, ...(done.description ? { description: done.description } : {}), type: "success" });
        }}
      />
      <AlertDialog open={deactivating !== null} onOpenChange={(open) => { if (!open && !pendingId) setDeactivating(null); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate {deactivating?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              They are signed out on every device straight away and can&apos;t sign in to this {t.business}.
              {deactivating?.practitionerId ? ` ${t.Customers} can no longer book them, and ${t.visits} already booked wait on the list of bookings to move.` : ""}
              {" "}Their history and records are kept, and you can reactivate them later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" disabled={Boolean(pendingId)} />}>Keep access</AlertDialogClose>
            <Button variant="destructive" loading={Boolean(pendingId)} onClick={() => deactivating && void setActive(deactivating, false)}>
              Deactivate and sign out
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function MemberStatus({ member }: { member: StaffTeamMember }) {
  if (!member.isActive) return <StatusBadge tone="neutral">Inactive</StatusBadge>;
  if (member.invitePending) {
    const expiry = inviteExpiry(member.inviteExpiresAt ?? null);
    return (
      <div className="flex flex-col items-start gap-0.5">
        <StatusBadge tone={expiry?.expired ? "danger" : "attention"}>{expiry?.expired ? "Invite expired" : "Invite pending"}</StatusBadge>
        {expiry && !expiry.expired ? <span className="text-xs text-muted-foreground">Link {expiry.label}</span> : null}
        {expiry?.expired ? <span className="text-xs text-muted-foreground">Send a new invite</span> : null}
      </div>
    );
  }
  return <StatusBadge tone="success">Active</StatusBadge>;
}

function InviteDialog({ open, onOpenChange, ownerActing, onInvited }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ownerActing: boolean;
  onInvited: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("receptionist");
  const [jobTitle, setJobTitle] = useState("");
  const places = useMemberLocationChoices();
  // Someone limited to some locations can only invite people limited to those, so the picker starts on their own.
  const [locationIds, setLocationIds] = useState<string[]>(() => places.myLocationIds);
  const { runWithStepUp } = useStepUp();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<{ name: string; link: AccountLink } | null>(null);
  const t = useTerms();
  const profile = useBusinessProfile();
  const { roleOption } = useRoleWords();

  function reset() {
    setName("");
    setEmail("");
    setRole("receptionist");
    setJobTitle("");
    setLocationIds(places.myLocationIds);
    setError("");
    setSent(null);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) { onOpenChange(next); if (!next) reset(); } }}>
      <DialogPopup className="sm:max-w-lg">
        {sent ? (
          <>
            <DialogHeader>
              <DialogTitle>{`Invite ready for ${sent.name}`}</DialogTitle>
              <DialogDescription>
                {"They open the link to join. Until they do, they show here as invited and can't sign in to your business."}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <AccessLinkNotice link={sent.link} name={sent.name} />
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={reset}>Invite someone else</Button>
              <DialogClose render={<Button />}>Done</DialogClose>
            </DialogFooter>
          </>
        ) : (
          <form
            className="contents"
            onSubmit={async (event) => {
              event.preventDefault();
              setPending(true);
              setError("");
              try {
                const result = await runWithStepUp(() => staffMutation<{ membershipId: string; invite: AccountLink }>("/api/staff/team/members", "POST", { name, email, role, ...(jobTitle.trim() ? { jobTitle } : {}), ...(places.show && locationIds.length > 0 ? { locationIds: normaliseLocationIds(locationIds) } : {}) }));
                setSent({ name: name.trim(), link: result.invite });
                onInvited();
              } catch (cause: unknown) {
                setError(cause instanceof Error ? cause.message : "The invite could not be sent.");
              } finally {
                setPending(false);
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>Invite staff</DialogTitle>
              <DialogDescription>For the front desk, billing or managers. {t.Providers} are added from the {t.Providers} page so {t.customers} can book them.</DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-4">
              {error ? <Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert> : null}
              <TextField id="invite-name" label="Full name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" required minLength={2} />
              <TextField id="invite-email" label="Work email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="off" required />
              <TextField id="invite-job-title" label="Job title" optional value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} autoComplete="off" maxLength={80} placeholder={profile.providerFields.titlePlaceholder} />
              <SelectField
                id="invite-role"
                label="Role"
                hint="You can switch single permissions on or off after they join."
                value={role}
                onValueChange={(value) => setRole(value as InviteRole)}
                options={inviteRoles.filter((item) => item !== "admin" || ownerActing).map(roleOption)}
              />
              {places.show ? <MemberLocationsField id="invite-locations" locations={places.locations} value={locationIds} onChange={setLocationIds} allowAll={places.allowAll} disabled={pending} /> : null}
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" disabled={pending} />}>Cancel</DialogClose>
              <Button type="submit" loading={pending}>Send invite</Button>
            </DialogFooter>
          </form>
        )}
      </DialogPopup>
    </Dialog>
  );
}

/** A person's job title: what they are called here. It changes nothing about their access, so it needs no second-factor check. */
function JobTitleDialog({ member, onClose, onSaved }: {
  member: StaffTeamMember | null;
  onClose: () => void;
  onSaved: (member: StaffTeamMember) => Promise<void>;
}) {
  return (
    <Dialog open={member !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup className="sm:max-w-md">
        {member ? <JobTitleForm key={member.membershipId} member={member} onDone={async () => { await onSaved(member); onClose(); }} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function JobTitleForm({ member, onDone }: { member: StaffTeamMember; onDone: () => Promise<void> }) {
  const [title, setTitle] = useState(member.jobTitle ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const profile = useBusinessProfile();
  return (
    <form
      className="contents"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError("");
        try {
          await staffMutation(`/api/staff/team/members/${member.membershipId}`, "PATCH", { jobTitle: title.trim() || null });
          await onDone();
        } catch (cause: unknown) {
          setError(cause instanceof Error ? cause.message : "The job title could not be saved.");
        } finally {
          setPending(false);
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>Job title for {member.name}</DialogTitle>
        <DialogDescription>Shown under their name on this page and in their account menu. It does not change what they can do.</DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-4">
        {error ? <Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <TextField id="member-job-title" label="Job title" value={title} onChange={(event) => setTitle(event.target.value)} autoComplete="off" maxLength={80} placeholder={profile.providerFields.titlePlaceholder} hint="Leave empty to show their role instead." />
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" disabled={pending} />}>Cancel</DialogClose>
        <Button type="submit" loading={pending}>Save</Button>
      </DialogFooter>
    </form>
  );
}

function EditAccessDialog({ member, onClose, ownerActing, actorPermissions, onSaved }: {
  member: StaffTeamMember | null;
  onClose: () => void;
  ownerActing: boolean;
  actorPermissions: readonly Permission[];
  onSaved: (member: StaffTeamMember) => Promise<void>;
}) {
  return (
    <Dialog open={member !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup className="sm:max-w-xl">
        {member ? (
          <EditAccessForm
            key={member.membershipId}
            member={member}
            ownerActing={ownerActing}
            actorPermissions={actorPermissions}
            onDone={async () => { await onSaved(member); onClose(); }}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function EditAccessForm({ member, ownerActing, actorPermissions, onDone }: {
  member: StaffTeamMember;
  ownerActing: boolean;
  actorPermissions: readonly Permission[];
  onDone: () => Promise<void>;
}) {
  const customRoles = useRoles(true).data ?? [];
  // A custom role (feature 53) is chosen from the same list as the built-in ones, as "custom:<id>".
  const [roleValue, setRoleValue] = useState<string>(member.customRoleId ? `custom:${member.customRoleId}` : member.role === "owner" ? "admin" : member.role);
  const custom = roleValue.startsWith("custom:") ? customRoles.find((item) => `custom:${item.id}` === roleValue) ?? null : null;
  const role: AssignableRole = custom ? custom.baseRole : roleValue as AssignableRole;
  const [checked, setChecked] = useState<Set<Permission>>(() => new Set(member.permissions));
  const [locationIds, setLocationIds] = useState<string[]>(() => member.locationIds ?? []);
  const places = useMemberLocationChoices();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const t = useTerms();
  const profile = useBusinessProfile();
  const { roleLabels, roleOption } = useRoleWords();
  const shownGroups = permissionGroupsFor(profile);
  const { runWithStepUp } = useStepUp();
  const preset = new Set<Permission>(custom ? custom.permissions : rolePresets[role]);
  const originalPermissions = new Set(member.permissions);
  const differences = permissionGroups.flatMap((group) => group.items).filter((item) => checked.has(item.key) !== preset.has(item.key)).length;
  const roles: AssignableRole[] = (["receptionist", "practitioner", "billing", "read_only", "admin"] as const)
    .filter((item) => (item !== "practitioner" || member.practitionerId) && (item !== "admin" || ownerActing || member.role === "admin"));

  return (
    <form
      className="contents"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError("");
        const permissionOverrides: PermissionOverrides = {};
        for (const group of permissionGroups) {
          for (const item of group.items) {
            if (checked.has(item.key) !== preset.has(item.key)) permissionOverrides[item.key] = checked.has(item.key);
          }
        }
        try {
          const locationChange = places.show && !sameLocationIds(locationIds, member.locationIds ?? []) ? { locationIds: normaliseLocationIds(locationIds) } : {};
          await runWithStepUp(() => staffMutation(`/api/staff/team/members/${member.membershipId}`, "PATCH", custom ? { customRoleId: custom.id, permissionOverrides, ...locationChange } : { role, permissionOverrides, ...locationChange }));
          await onDone();
        } catch (cause: unknown) {
          setError(cause instanceof Error ? cause.message : "The change could not be saved.");
        } finally {
          setPending(false);
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>Access for {member.name}</DialogTitle>
        <DialogDescription>Pick a role, then switch single permissions on or off. Changes apply from their next click.</DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-5">
        {error ? <Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <SelectField
          id="access-role"
          label="Role"
          hint={member.practitionerId ? undefined : `${t.Provider} is offered once they have ${t.aProvider} profile.`}
          value={roleValue}
          onValueChange={(value) => {
            setRoleValue(value);
            const picked = value.startsWith("custom:") ? customRoles.find((item) => `custom:${item.id}` === value) : undefined;
            setChecked(new Set(picked ? picked.permissions : rolePresets[value as AssignableRole]));
          }}
          options={[...roles.map(roleOption), ...customRoles.filter((item) => ownerActing || item.baseRole !== "admin").map((item) => ({ value: `custom:${item.id}`, label: item.name }))]}
        />
        {places.show ? <MemberLocationsField id="access-locations" locations={places.locations} value={locationIds} onChange={setLocationIds} allowAll={places.allowAll} disabled={pending} /> : null}
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {differences === 0 ? `Same as the ${custom?.name ?? roleLabels[role]} role.` : `${differences} ${differences === 1 ? "change" : "changes"} from the ${custom?.name ?? roleLabels[role]} role.`}
          </p>
          <Button type="button" variant="outline" size="sm" disabled={differences === 0} onClick={() => setChecked(new Set(preset))}>
            Reset to role defaults
          </Button>
        </div>
        {shownGroups.map((group) => (
          <fieldset key={group.title} className="flex flex-col gap-1">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">{group.title}</legend>
            <div className="flex flex-col divide-y rounded-lg border">
              {group.items.map((item) => {
                const on = checked.has(item.key);
                const changed = on !== preset.has(item.key);
                // Nobody can hand out a permission they don't hold; taking one away is always allowed.
                const locked = !on && !actorPermissions.includes(item.key) && !originalPermissions.has(item.key);
                const id = `permission-${item.key.replace(".", "-")}`;
                return (
                  <div key={item.key} className="flex items-start gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <label htmlFor={id} className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {item.label}
                        {changed ? <Badge variant={on ? "info" : "warning"} size="sm">{on ? "Added" : "Removed"}</Badge> : null}
                      </label>
                      <p className="text-xs text-muted-foreground">{locked ? "You don't have this permission yourself, so you can't give it." : item.description}</p>
                    </div>
                    <Switch
                      id={id}
                      checked={on}
                      disabled={locked || pending}
                      onCheckedChange={(next: boolean) => setChecked((current) => {
                        const copy = new Set(current);
                        if (next) copy.add(item.key);
                        else copy.delete(item.key);
                        return copy;
                      })}
                    />
                  </div>
                );
              })}
            </div>
          </fieldset>
        ))}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" disabled={pending} />}>Cancel</DialogClose>
        <Button type="submit" loading={pending}>Save access</Button>
      </DialogFooter>
    </form>
  );
}
