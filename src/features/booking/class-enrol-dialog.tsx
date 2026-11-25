"use client";

import Link from "next/link";
import { CalendarDays, CheckCircle2, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { PhoneField, SelectField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { enrolSchema, type EnrolInput, type EnrolResult, type TimetableSession } from "@/lib/classes-contracts";

import { useTerms } from "../terms/business-profile-context";
import { formatLongDate, formatTime } from "./booking-format";

type Field = "firstName" | "lastName" | "phone" | "email" | "preferredChannel" | "privacy" | "form";
type FieldErrors = Partial<Record<Field, string>>;
type Channel = EnrolInput["preferredChannel"];

const channelOptions: Array<{ value: Channel; label: string }> = [
  { value: "email", label: "Email" },
  { value: "sms", label: "Text message" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "phone", label: "Phone call" },
];

function createKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `class-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The server's field names on this form map to the ones shown here. */
function fieldFor(name: string): Field {
  if (name === "acceptedPrivacyNotice") return "privacy";
  if (name === "firstName" || name === "lastName" || name === "phone" || name === "email" || name === "preferredChannel") return name;
  return "form";
}

/**
 * Taking a seat in a class, or joining its waiting list (feature 18). One form: name, a way to reach the person, how they
 * want to hear, and the privacy tick. A seat taken a moment before gets a plain message and one button to join the waiting
 * list instead, which sends the form again under a new idempotency key.
 */
function EnrolBody({ session, clinicSlug, businessName, locale, zone, onClose, onChanged }: {
  session: TimetableSession;
  clinicSlug: string;
  businessName: string;
  locale: string;
  zone: string;
  onClose: () => void;
  /** Called after any answer from the server so the timetable shows the new seat count. */
  onChanged: () => void;
}) {
  const t = useTerms();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [channel, setChannel] = useState<Channel>("email");
  const [messaging, setMessaging] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pending, setPending] = useState(false);
  const [lastSeat, setLastSeat] = useState(false);
  const [retryable, setRetryable] = useState(false);
  const [result, setResult] = useState<EnrolResult | null>(null);
  const attempt = useRef<{ key: string; payload: string } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (result) headingRef.current?.focus(); }, [result]);

  const joining = session.state === "full" || lastSeat;

  async function send(joinWaitlist: boolean) {
    const input = { clinicSlug, firstName: firstName.trim(), lastName: lastName.trim(), phone: phone.trim(), email: email.trim(), preferredChannel: channel, acceptedPrivacyNotice: privacy, messagingConsent: messaging, joinWaitlist };
    const found: FieldErrors = {};
    if (input.firstName.length < 2) found.firstName = "Enter your first name.";
    if (!input.lastName) found.lastName = "Enter your last name.";
    if (!input.email && !input.phone) found.email = "Give an email address or a phone number so we can reach you.";
    else if (input.email && !/^\S+@\S+\.\S+$/.test(input.email)) found.email = "Enter a valid email address.";
    if (input.phone && input.phone.length < 8) found.phone = "Enter a valid phone number.";
    if (channel === "email" && !input.email && !found.email) found.preferredChannel = "Add an email address, or choose another way to hear from us.";
    if (channel !== "email" && !input.phone) found.preferredChannel = "Add a phone number, or choose email.";
    if (!privacy) found.privacy = "Agree to this use of your details to continue.";
    if (Object.keys(found).length === 0) {
      const parsed = enrolSchema.safeParse(input);
      if (!parsed.success) found.form = "Check your details and try again.";
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    // One key for each send; the same key again only when the same form is retried after a failure.
    const payload = JSON.stringify(input);
    if (!attempt.current || attempt.current.payload !== payload) attempt.current = { key: createKey(), payload };
    setPending(true);
    setRetryable(false);
    try {
      const response = await fetch(`/api/public/classes/${encodeURIComponent(session.id)}/enrol`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": attempt.current.key },
        body: payload,
      });
      const body = (await response.json().catch(() => null)) as { data?: EnrolResult; error?: { code?: string; message?: string; fieldErrors?: Record<string, string[]>; details?: { waitlistOpen?: boolean } } } | null;
      if (response.ok && body?.data) {
        attempt.current = null;
        setResult(body.data);
        onChanged();
        return;
      }
      const error = body?.error;
      if (error?.code === "class_full" && error.details?.waitlistOpen) {
        attempt.current = null;
        setLastSeat(true);
        setErrors({});
        onChanged();
        return;
      }
      const next: FieldErrors = {};
      for (const [name, messages] of Object.entries(error?.fieldErrors ?? {})) {
        const field = fieldFor(name);
        if (messages[0] && field !== "form") next[field] ??= messages[0];
      }
      const hasFieldErrors = Object.keys(next).length > 0;
      if (!hasFieldErrors) next.form = error?.message ?? "We could not complete this. Please try again.";
      setErrors(next);
      const final = ["class_closed", "already_enrolled", "session_not_found"].includes(error?.code ?? "");
      setRetryable(!final && !hasFieldErrors);
      if (final) { attempt.current = null; onChanged(); }
    } catch {
      setErrors({ form: "We could not reach the server. Check your connection and try again." });
      setRetryable(true);
    } finally {
      setPending(false);
    }
  }

  const when = `${formatLongDate(session.startsAt, locale, zone)} at ${formatTime(session.startsAt, locale, zone)}`;

  return (
    <>
        {result ? (
          <>
            <DialogHeader>
              <div aria-hidden="true" className="mb-1 flex size-10 items-center justify-center rounded-full bg-success/8 text-success-foreground"><CheckCircle2 className="size-5" /></div>
              <DialogTitle><span ref={headingRef} tabIndex={-1} className="outline-none">{result.status === "booked" ? "You’re booked" : `You’re number ${result.position} on the waiting list`}</span></DialogTitle>
              <DialogDescription>
                {result.status === "booked" ? "A confirmation is on its way." : "We’ll message you when a seat opens. Nothing is booked until you take it."}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-3">
              <Alert variant="success" role="status">
                <CalendarDays aria-hidden="true" />
                <AlertDescription>{`${session.serviceName} with ${session.teacherName}, ${when}.`}</AlertDescription>
              </Alert>
              <p className="text-sm">
                <Link href={`/class/${encodeURIComponent(result.manageToken)}`} className="inline-flex min-h-11 items-center font-medium underline underline-offset-4">See or cancel your place</Link>
              </p>
            </DialogPanel>
            <DialogFooter><Button size="lg" onClick={onClose}>Done</Button></DialogFooter>
          </>
        ) : (
          <Form className="contents" noValidate onSubmit={(event) => { event.preventDefault(); void send(joining); }}>
            <DialogHeader>
              <DialogTitle>{session.state === "full" ? "Join the waiting list" : "Book a seat"}</DialogTitle>
              <DialogDescription>
                {`${session.serviceName} with ${session.teacherName}, ${when}. `}
                {session.state === "full" ? "This class is full. We’ll message you if a seat opens." : `${session.seatsLeft} ${session.seatsLeft === 1 ? "seat" : "seats"} left.`}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-5">
              {lastSeat ? (
                <Alert variant="warning" role="alert">
                  <TriangleAlert aria-hidden="true" />
                  <AlertDescription>Someone just took the last seat. Join the waiting list and we’ll message you if one opens.</AlertDescription>
                </Alert>
              ) : null}
              {errors.form ? (
                <Alert variant="error" role="alert">
                  <TriangleAlert aria-hidden="true" />
                  <AlertDescription className="flex flex-col items-start gap-2">
                    <span>{errors.form}</span>
                    {retryable ? <Button type="button" variant="outline" onClick={() => void send(joining)} disabled={pending}>Retry</Button> : null}
                  </AlertDescription>
                </Alert>
              ) : null}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <TextField id="class-first-name" label="First name" autoComplete="given-name" value={firstName} onChange={(event) => setFirstName(event.target.value)} error={errors.firstName} />
                <TextField id="class-last-name" label="Last name" autoComplete="family-name" value={lastName} onChange={(event) => setLastName(event.target.value)} error={errors.lastName} />
              </div>
              <PhoneField id="class-phone" label="Mobile number" autoComplete="tel" optional value={phone} onChange={setPhone} error={errors.phone} />
              <TextField id="class-email" label="Email address" type="email" autoComplete="email" optional hint="Give an email, a mobile number, or both." value={email} onChange={(event) => setEmail(event.target.value)} error={errors.email} />
              <SelectField id="class-channel" label="How should we reach you?" value={channel} onValueChange={(next) => setChannel((next || "email") as Channel)} options={channelOptions} error={errors.preferredChannel} />
              <div className="flex flex-col gap-3 border-t pt-4">
                <Label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg sm:min-h-8">
                  <Checkbox className="mt-0.5" checked={messaging} onCheckedChange={(checked) => setMessaging(Boolean(checked))} />
                  <span className="flex flex-col gap-0.5">
                    <span>Send reminders by text message or WhatsApp</span>
                    <span className="font-normal text-muted-foreground text-xs">{`Otherwise ${businessName} sends reminders by email.`}</span>
                  </span>
                </Label>
                <div className="flex flex-col gap-1.5">
                  <Label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg sm:min-h-8">
                    <Checkbox className="mt-0.5" checked={privacy} onCheckedChange={(checked) => setPrivacy(Boolean(checked))} aria-invalid={Boolean(errors.privacy)} aria-describedby={errors.privacy ? "class-privacy-error" : undefined} />
                    <span>I understand and agree to this use of the booking details.</span>
                  </Label>
                  <Collapsible className="ps-7">
                    <CollapsibleTrigger render={<Button type="button" variant="link" size="sm" className="h-auto min-h-8 px-0" />}>Read the privacy notice</CollapsibleTrigger>
                    <CollapsiblePanel>
                      <p className="flex gap-2 pt-1 pb-1 text-muted-foreground text-sm">
                        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success-foreground" aria-hidden="true" />
                        <span>{`Kalendr shares these details with ${businessName}. They are used to arrange and communicate about this ${t.service}. Avoid entering sensitive personal information here.`}</span>
                      </p>
                    </CollapsiblePanel>
                  </Collapsible>
                  {errors.privacy ? <p id="class-privacy-error" role="alert" className="ps-7 text-destructive-foreground text-xs">{errors.privacy}</p> : null}
                </div>
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="ghost" size="lg" disabled={pending} onClick={onClose}>Cancel</Button>
              <Button type="submit" size="lg" loading={pending}>{joining ? "Join the waiting list" : "Book my seat"}</Button>
            </DialogFooter>
          </Form>
        )}
    </>
  );
}

/**
 * The dialog around the form. Each class opened gets a fresh form (the body is keyed by the class). The caller keeps the
 * `session` object while the timetable refreshes behind it, so a seat count changing does not reset what was typed.
 */
export function ClassEnrolDialog({ session, onClose, ...rest }: {
  /** The class being booked; null keeps the dialog shut. */
  session: TimetableSession | null;
  clinicSlug: string;
  businessName: string;
  locale: string;
  zone: string;
  onClose: () => void;
  /** Called after any answer from the server so the timetable shows the new seat count. */
  onChanged: () => void;
}) {
  return (
    <Dialog open={session !== null} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPopup>{session ? <EnrolBody key={session.id} session={session} onClose={onClose} {...rest} /> : null}</DialogPopup>
    </Dialog>
  );
}
