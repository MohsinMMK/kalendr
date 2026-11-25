"use client";

import { useState } from "react";

import { SelectField } from "@/components/form-fields";
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
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { useTerms } from "@/features/terms/business-profile-context";
import type { StaffTeamMember } from "@/lib/staff-snapshot";

import { useCatalogLookups } from "./clinic-catalog";
import { staffMutation, useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { useStepUp } from "./step-up-dialog";

/**
 * The confirmations behind the team list's actions menu: remove, cancel an invite, sign out everywhere, hand over the
 * business, and link or unlink a login and its bookable profile. Each asks for a recent second factor through the same
 * step-up prompt as editing access, and tells the person what will happen before it does.
 */

export type MemberActionKind = "remove" | "cancel_invite" | "sign_out" | "transfer" | "link" | "unlink";

export interface MemberAction {
  kind: MemberActionKind;
  member: StaffTeamMember;
}

interface Done {
  title: string;
  description?: string;
}

export function MemberActionDialogs({ action, onClose, onDone }: {
  action: MemberAction | null;
  onClose: () => void;
  onDone: (done: Done) => Promise<void>;
}) {
  if (action?.kind === "link") return <LinkProfileDialog member={action.member} onClose={onClose} onDone={onDone} />;
  return <ConfirmMemberAction action={action} onClose={onClose} onDone={onDone} />;
}

function useAction(onClose: () => void, onDone: (done: Done) => Promise<void>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { runWithStepUp } = useStepUp();
  async function run<T>(request: () => Promise<T>, done: (result: T) => Done) {
    setPending(true);
    setError("");
    try {
      const result = await runWithStepUp(request);
      await onDone(done(result));
      onClose();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "That could not be done.");
    } finally {
      setPending(false);
    }
  }
  return { pending, error, run, clear: () => setError("") };
}

function ConfirmMemberAction({ action, onClose, onDone }: { action: MemberAction | null; onClose: () => void; onDone: (done: Done) => Promise<void> }) {
  const t = useTerms();
  const { pending, error, run, clear } = useAction(onClose, onDone);
  const member = action?.member;
  const name = member?.name ?? "";
  const base = member ? `/api/staff/team/members/${member.membershipId}` : "";
  const needsSecondFactor = action?.kind === "transfer" && member?.secondFactor === false;

  const copy: Record<Exclude<MemberActionKind, "link">, { title: string; description: string; confirm: string; destructive: boolean; request: () => Promise<unknown>; done: (result: unknown) => Done }> = {
    remove: {
      title: `Remove ${name} from the team?`,
      description: `They lose access straight away and are signed out on every device.${member?.practitionerId ? ` Their ${t.provider} profile and history stay, ${t.customers} can no longer book them, and ${t.visits} already booked wait on the reassign list.` : " Their history stays."} You can invite them again later.`,
      confirm: "Remove from team",
      destructive: true,
      request: () => staffMutation<{ futureBookings: number }>(`${base}/remove`, "POST", {}),
      done: (result) => {
        const bookings = (result as { futureBookings?: number }).futureBookings ?? 0;
        return { title: `${name} was removed`, description: bookings > 0 ? `${bookings} upcoming ${bookings === 1 ? t.visit : t.visits} need someone else. Find them under Provisioning, reassign.` : "They were signed out on every device." };
      },
    },
    cancel_invite: {
      title: `Cancel the invite for ${name}?`,
      description: "The link stops working and they are taken off the team, so they can't get in another way either. You can invite them again later.",
      confirm: "Cancel invite",
      destructive: true,
      request: () => staffMutation(`${base}/cancel-invite`, "POST", {}),
      done: () => ({ title: `The invite for ${name} was cancelled` }),
    },
    sign_out: {
      title: `Sign ${name} out everywhere?`,
      description: "They are signed out on every device straight away. They can sign in again with their usual method; to stop that, deactivate them instead.",
      confirm: "Sign out everywhere",
      destructive: false,
      request: () => staffMutation(`${base}/sign-out`, "POST", {}),
      done: () => ({ title: `${name} was signed out on every device` }),
    },
    transfer: {
      title: `Make ${name} the owner?`,
      description: `${name} becomes the owner of this ${t.business} with full access, including billing and ownership. You become an admin, and only the new owner can hand it back.${needsSecondFactor ? ` ${name} needs an authenticator app or a passkey first (Profile, Security).` : ""}`,
      confirm: "Make owner",
      destructive: true,
      request: () => staffMutation("/api/staff/team/ownership", "POST", { membershipId: member?.membershipId }),
      done: () => ({ title: `${name} is now the owner`, description: "You are an admin now." }),
    },
    unlink: {
      title: `Unlink ${name} from their profile?`,
      description: `Their ${t.provider} profile, calendar and history stay. ${name} keeps their login but can no longer take bookings. You can link another profile later.`,
      confirm: "Unlink profile",
      destructive: false,
      request: () => staffMutation(`${base}/profile-link`, "DELETE", {}),
      done: () => ({ title: `${name} was unlinked from their profile` }),
    },
  };
  const current = action && action.kind !== "link" ? copy[action.kind] : null;

  return (
    <AlertDialog open={current !== null} onOpenChange={(open) => { if (!open && !pending) { clear(); onClose(); } }}>
      <AlertDialogPopup>
        {current ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{current.title}</AlertDialogTitle>
              <AlertDialogDescription>{current.description}</AlertDialogDescription>
            </AlertDialogHeader>
            {error ? <Alert variant="error" className="mx-6 mb-2"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="ghost" disabled={pending} />}>Not now</AlertDialogClose>
              <Button
                variant={current.destructive ? "destructive" : "default"}
                loading={pending}
                disabled={needsSecondFactor}
                onClick={() => void run(current.request, current.done)}
              >
                {current.confirm}
              </Button>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** Links a team login to a bookable profile that has no login yet. */
function LinkProfileDialog({ member, onClose, onDone }: { member: StaffTeamMember; onClose: () => void; onDone: (done: Done) => Promise<void> }) {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const staff = useOptionalStaffSnapshot();
  const linked = new Set((staff?.snapshot?.team ?? []).map((person) => person.practitionerId).filter(Boolean));
  const free = catalog.practitioners.filter((person) => person.isActive !== false && !linked.has(person.id));
  const [profileId, setProfileId] = useState("");
  const { pending, error, run, clear } = useAction(onClose, onDone);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) { clear(); onClose(); } }}>
      <DialogPopup className="sm:max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () => staffMutation(`/api/staff/team/members/${member.membershipId}/profile-link`, "POST", { practitionerId: profileId }),
              () => ({ title: `${member.name} is now linked to their ${t.provider} profile` }),
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>Link {member.name} to a {t.provider} profile</DialogTitle>
            <DialogDescription>
              The login stays as it is. {t.Customers} can book the profile, and {member.name} sees their own {t.visits}. Only profiles without a login are listed.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {error ? <Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert> : null}
            {free.length === 0 ? (
              <p className="text-sm text-muted-foreground">Every active {t.provider} profile already has a login. Add one from the {t.Providers} page first.</p>
            ) : (
              <SelectField
                id="link-profile"
                label={`${t.Provider} profile`}
                value={profileId}
                onValueChange={setProfileId}
                placeholder={`Choose a ${t.provider}`}
                options={free.map((person) => ({ value: person.id, label: `${person.name} — ${person.specialty}` }))}
              />
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" disabled={pending} />}>Cancel</DialogClose>
            <Button type="submit" loading={pending} disabled={!profileId}>Link profile</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
