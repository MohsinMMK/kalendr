"use client";

import { useState } from "react";

import { TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { toastManager } from "@/components/ui/toast";
import { staffMemberEmailChangeSchema, staffOwnEmailChangeSchema, type StaffMemberEmailChangeResult } from "@/lib/staff-email";
import type { StaffTeamMember } from "@/lib/staff-snapshot";

import { AccessLinkNotice } from "./access-link-notice";
import { StaffApiError } from "./queries/http";
import { staffMutation } from "./staff-snapshot-provider";
import { useStepUp } from "./step-up-dialog";

/** The message to put beside the field: the server's own words for the field, else for the whole request. */
function fieldMessage(cause: unknown): { field: string; general: string } {
  if (cause instanceof StaffApiError) {
    const field = cause.fieldErrors.newEmail?.[0] ?? cause.fieldErrors.email?.[0] ?? "";
    return { field, general: field ? "" : cause.message };
  }
  return { field: "", general: cause instanceof Error ? cause.message : "The email could not be changed." };
}

/**
 * Asks for a new sign-in email and sends it to `endpoint`. A fresh second-factor code is asked for by the step-up prompt when the
 * server wants one. Shared by a person's own profile and by a manager changing a teammate's email.
 */
function EmailChangeForm({ endpoint, schema, label, hint, submit, onSent }: {
  endpoint: string;
  schema: typeof staffOwnEmailChangeSchema | typeof staffMemberEmailChangeSchema;
  label: string;
  hint: string;
  submit: string;
  onSent: (result: unknown) => void;
}) {
  const { runWithStepUp } = useStepUp();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [fieldError, setFieldError] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="contents"
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        setFieldError("");
        setError("");
        const parsed = schema.safeParse({ newEmail: value });
        if (!parsed.success) {
          setFieldError(parsed.error.issues[0]?.message ?? "Enter a full email address, like name@example.com.");
          return;
        }
        setPending(true);
        try {
          onSent(await runWithStepUp(() => staffMutation(endpoint, "POST", parsed.data)));
        } catch (cause: unknown) {
          const message = fieldMessage(cause);
          setFieldError(message.field);
          setError(message.general);
        } finally {
          setPending(false);
        }
      }}
    >
      <DialogPanel className="flex flex-col gap-4">
        {error ? <Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <TextField id="new-sign-in-email" type="email" label={label} value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" autoFocus maxLength={254} error={fieldError || undefined} hint={hint} />
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" disabled={pending} />}>Cancel</DialogClose>
        <Button type="submit" loading={pending}>{submit}</Button>
      </DialogFooter>
    </form>
  );
}

/** My profile → Change email. A link goes to the new address; the email changes only when it is opened. */
export function OwnEmailDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [sent, setSent] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) setSent(false); }}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{sent ? "Check your new inbox" : "Change your sign-in email"}</DialogTitle>
          <DialogDescription>
            {sent
              ? "We sent a link to the new address. Your email changes when you open it, and it works for one hour. Until then, keep signing in with your current email."
              : "We email a link to the new address. Your email changes only when you open it. If you use an authenticator app or a passkey, you'll be asked for a code first."}
          </DialogDescription>
        </DialogHeader>
        {sent ? (
          <DialogFooter><DialogClose render={<Button />}>Done</DialogClose></DialogFooter>
        ) : (
          <EmailChangeForm endpoint="/api/staff/me/email" schema={staffOwnEmailChangeSchema} label="New email" hint="Use an address you can open right now." submit="Send link" onSent={() => setSent(true)} />
        )}
      </DialogPopup>
    </Dialog>
  );
}

/** Team → ⋯ → Change email: an owner or admin sets a teammate's sign-in email. */
export function MemberEmailDialog({ member, onClose, onSaved }: {
  member: StaffTeamMember | null;
  onClose: () => void;
  onSaved?: () => void | Promise<void>;
}) {
  const [done, setDone] = useState<StaffMemberEmailChangeResult | null>(null);
  function close() {
    setDone(null);
    onClose();
  }
  return (
    <Dialog open={member !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogPopup className="sm:max-w-md">
        {member ? (
          <>
            <DialogHeader>
              <DialogTitle>{done ? `${member.name}'s email was changed` : `Change email for ${member.name}`}</DialogTitle>
              <DialogDescription>
                {done
                  ? "They were signed out on every device and both addresses were told. They confirm the new address the next time they sign in."
                  : "They are signed out everywhere, and any Google or Microsoft sign-in tied to the old address is removed. Their old address is told, and so is the new one. You'll be asked for an authenticator code."}
              </DialogDescription>
            </DialogHeader>
            {done ? (
              <>
                <DialogPanel className="flex flex-col gap-4">
                  {done.invite ? <AccessLinkNotice link={done.invite} name={member.name} kind="invite" /> : null}
                </DialogPanel>
                <DialogFooter><DialogClose render={<Button />}>Done</DialogClose></DialogFooter>
              </>
            ) : (
              <EmailChangeForm
                key={member.membershipId}
                endpoint={`/api/staff/team/members/${member.membershipId}/email`}
                schema={staffMemberEmailChangeSchema}
                label="New email"
                hint="Their current email stops working for sign-in."
                submit="Change email"
                onSent={(result) => {
                  setDone(result as StaffMemberEmailChangeResult);
                  toastManager.add({ title: `${member.name}'s email was changed`, type: "success" });
                  void onSaved?.();
                }}
              />
            )}
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
