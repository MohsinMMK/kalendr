"use client";

import { CalendarClock, Info, Phone, TriangleAlert, Users } from "lucide-react";
import { useState, type ReactNode } from "react";
import { z } from "zod";

import { TextareaField } from "@/components/form-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardFooter, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Fieldset, FieldsetLegend } from "@/components/ui/fieldset";
import { Form } from "@/components/ui/form";
import { RadioGroup } from "@/components/ui/radio-group";
import { customerCancelReasonLabels, customerCancelReasons, MAX_NOTE_LENGTH, type CustomerCancelReason } from "@/lib/cancel-policy";

import { useTerms } from "../terms/business-profile-context";
import { formatDateTime, phoneHref } from "./booking-format";
import type { ManageBookingSnapshot } from "./booking-types";
import { EmailList } from "./email-list";
import { RadioCard } from "./radio-card";

/** Counter text under a note box. */
export function noteHint(value: string): string {
  return `${value.length} of ${MAX_NOTE_LENGTH}`;
}

/** The message with the business phone turned into a call link, when the message names it. */
function MessageWithPhone({ message, phone }: { message: string; phone: string }): ReactNode {
  const at = phone ? message.indexOf(phone) : -1;
  if (at < 0) return message;
  return (
    <>
      {message.slice(0, at)}
      <a href={phoneHref(phone)} className="font-medium text-foreground underline underline-offset-2 tabular-nums">
        {phone}
      </a>
      {message.slice(at + phone.length)}
    </>
  );
}

/**
 * What stands where a Cancel or Change time button would be when the business's policy does not allow it. Words,
 * never a disabled button, and a way to call.
 */
export function PolicyBlockedNotice({ messages, phone }: { messages: string[]; phone: string }) {
  const unique = [...new Set(messages.filter(Boolean))];
  if (unique.length === 0) return null;
  const phoneShown = unique.some((message) => phone && message.includes(phone));
  return (
    <Alert role={undefined} variant="info">
      <Info aria-hidden="true" />
      <AlertDescription>
        {unique.map((message) => (
          <p key={message}>
            <MessageWithPhone message={message} phone={phone} />
          </p>
        ))}
        {!phoneShown && phone ? (
          <Button variant="outline" className="min-h-11 w-fit tabular-nums sm:min-h-8" render={<a href={phoneHref(phone)} />}>
            <Phone aria-hidden="true" />
            Call {phone}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** Shown when staff asked the customer to pick a new time. */
export function RescheduleRequestBanner({ snapshot }: { snapshot: ManageBookingSnapshot }) {
  const { clinic, location, manage } = snapshot;
  return (
    <Alert role={undefined} variant="warning">
      <CalendarClock aria-hidden="true" />
      <AlertTitle>{clinic.name} asked you to choose a new time</AlertTitle>
      <AlertDescription>
        {manage?.rescheduleDeadline ? (
          <p>
            Please choose by{" "}
            <span className="font-medium text-foreground tabular-nums">
              {formatDateTime(manage.rescheduleDeadline, clinic.locale, location.timezone)}
            </span>
            ; after that the booking is cancelled.
          </p>
        ) : (
          <p>Please choose a new time soon. If you do not, the booking may be cancelled.</p>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** The cancel dialog: a reason, an optional note, a clear confirm. Refusals from the server show inside it. */
export function CancelDialog({
  open,
  clinical,
  submitting,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  clinical: boolean;
  submitting: boolean;
  error: string;
  onClose: () => void;
  onConfirm: (input: { reasonCode: CustomerCancelReason; note?: string }) => void;
}) {
  const t = useTerms();
  const [reason, setReason] = useState<CustomerCancelReason | "">("");
  const [note, setNote] = useState("");
  const [reasonError, setReasonError] = useState("");
  const reasons = customerCancelReasons.filter((code) => clinical || code !== "feeling_better");

  function close() {
    setReason("");
    setNote("");
    setReasonError("");
    onClose();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) close();
      }}
    >
      <DialogPopup>
        <Form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (!reason) {
              setReasonError("Choose a reason before continuing.");
              return;
            }
            onConfirm({ reasonCode: reason, note: note.trim() || undefined });
          }}
        >
          <DialogHeader>
            <DialogTitle>Cancel your {t.appointment}?</DialogTitle>
            <DialogDescription>
              Cancelling frees this time for someone else. You can book a new time afterwards.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {error ? (
              <Alert variant="error">
                <TriangleAlert aria-hidden="true" />
                <AlertTitle>We could not cancel the {t.appointment}</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <Fieldset className="flex min-w-0 max-w-none flex-col gap-2">
              <FieldsetLegend id="cancel-reason-legend" className="font-medium text-sm">
                Why are you cancelling?
              </FieldsetLegend>
              <RadioGroup
                name="cancel-reason"
                aria-labelledby="cancel-reason-legend"
                aria-describedby={reasonError ? "cancel-reason-error" : undefined}
                value={reason || null}
                onValueChange={(value) => {
                  setReason(value as CustomerCancelReason);
                  setReasonError("");
                }}
                className="grid gap-2"
              >
                {reasons.map((code) => (
                  <RadioCard key={code} value={code} className="min-h-11 items-center p-3 sm:p-3">
                    <span>{customerCancelReasonLabels[code]}</span>
                  </RadioCard>
                ))}
              </RadioGroup>
              {reasonError ? (
                <p id="cancel-reason-error" role="alert" className="text-destructive-foreground text-sm">
                  {reasonError}
                </p>
              ) : null}
            </Fieldset>
            <TextareaField
              id="cancel-note"
              label="Anything we should know?"
              optional
              value={note}
              maxLength={MAX_NOTE_LENGTH}
              hint={noteHint(note)}
              onChange={(event) => setNote(event.target.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="lg" onClick={close} disabled={submitting}>
              Keep it
            </Button>
            <Button type="submit" variant="destructive" size="lg" loading={submitting}>
              Cancel my {t.appointment}
            </Button>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
}

const guestEmailSchema = z.email();

/** Add or remove guests on a booking. Saving sends the whole list. */
export function GuestsCard({
  snapshot,
  saving,
  error,
  onSave,
}: {
  snapshot: ManageBookingSnapshot;
  saving: boolean;
  error: string;
  onSave: (guests: string[]) => void;
}) {
  const [guests, setGuests] = useState<string[]>(snapshot.guests ?? []);
  const [localError, setLocalError] = useState("");
  const max = Math.min(Math.max(snapshot.service.intake?.maxGuests ?? 1, 1), 10);
  const shownError = localError || error;
  return (
    <Card render={<section aria-labelledby="guests-heading" />}>
      <Form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault();
          if (guests.some((email) => !guestEmailSchema.safeParse(email).success)) {
            setLocalError("Check the email addresses. Each one should look like name@example.com.");
            return;
          }
          setLocalError("");
          onSave(guests);
        }}
      >
        <CardHeader className="p-5 pb-3">
          <CardTitle render={<h2 id="guests-heading" />} className="flex items-center gap-2 text-base">
            <Users className="size-4" aria-hidden="true" />
            Guests
          </CardTitle>
        </CardHeader>
        <CardPanel className="flex flex-col gap-3 p-5 pt-0">
          <p className="text-muted-foreground text-sm">
            Guests get the details by email. You can add up to {max}.
          </p>
          <EmailList
            id="guest-edit"
            value={guests}
            onChange={(next) => {
              setGuests(next);
              setLocalError("");
            }}
            max={max}
            rowLabel="Guest email"
            addLabel="Add a guest"
            invalid={Boolean(shownError)}
            describedBy={shownError ? "guest-edit-error" : undefined}
            disabled={saving}
          />
          {shownError ? (
            <p id="guest-edit-error" role="alert" className="text-destructive-foreground text-sm">
              {shownError}
            </p>
          ) : null}
        </CardPanel>
        <CardFooter className="border-t p-4 sm:px-5">
          <Button type="submit" size="lg" variant="outline" loading={saving} className="w-full sm:w-auto">
            Save guests
          </Button>
        </CardFooter>
      </Form>
    </Card>
  );
}
