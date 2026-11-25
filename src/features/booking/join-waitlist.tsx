"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BellRing, CheckCircle2, TriangleAlert } from "lucide-react";

import { PhoneField, TextField } from "@/components/form-fields";
import { TurnstileField, useBotCheck } from "@/components/turnstile-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { bookingBotFieldNames } from "@/lib/bot-check";
import type { Clinic, Location, Practitioner, Service } from "@/lib/domain";
import { WAITLIST_MAX_DAYS, type WaitlistJoinResult } from "@/lib/waitlist-contracts";
import type { TimePreference } from "@/lib/waitlist";

import { useTerms } from "../terms/business-profile-context";

const timeChoices: Array<{ value: TimePreference; label: string; hint: string }> = [
  { value: "any", label: "Any time", hint: "Whenever something opens" },
  { value: "morning", label: "Morning", hint: "Before 12 noon" },
  { value: "afternoon", label: "Afternoon", hint: "12 noon to 5 pm" },
  { value: "evening", label: "Evening", hint: "5 pm onwards" },
];

/** A calendar day (yyyy-mm-dd) in a place's own time zone, `offsetDays` from today. */
export function dayIn(timeZone: string, offsetDays = 0, from = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(from + offsetDays * 86_400_000));
}

type FieldErrors = Partial<Record<"firstName" | "lastName" | "phone" | "email" | "dateFrom" | "dateTo" | "privacy" | "form", string>>;

/**
 * "No time suits?" on the booking page's time step (feature 21). A customer says which service, which people, between
 * which dates and what time of day, and is told by message when a time opens. It uses the same bot filters and consent
 * wording as the booking form, and never promises a time: it says what happens next.
 */
export function JoinWaitlist({ clinic, service, location, people, turnstileSiteKey = null }: {
  clinic: Clinic;
  service: Service;
  location: Location;
  /** The people who offer this service at this place. */
  people: Practitioner[];
  turnstileSiteKey?: string | null;
}) {
  const t = useTerms();
  const bot = useBotCheck();
  const [open, setOpen] = useState(false);
  const zone = location.timezone || clinic.timezone;
  const [dateFrom, setDateFrom] = useState(() => dayIn(zone, 1));
  const [dateTo, setDateTo] = useState(() => dayIn(zone, 14));
  const [timePreference, setTimePreference] = useState<TimePreference>("any");
  const [chosen, setChosen] = useState<string[]>([]);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [messaging, setMessaging] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<WaitlistJoinResult | null>(null);
  const honeypot = useRef<HTMLInputElement>(null);
  const openedAt = useRef<number | null>(null);
  const today = useMemo(() => dayIn(zone), [zone]);
  const latest = useMemo(() => dayIn(zone, WAITLIST_MAX_DAYS), [zone]);

  useEffect(() => { if (open) openedAt.current = Date.now(); }, [open]);

  function validate(): FieldErrors {
    const found: FieldErrors = {};
    if (firstName.trim().length < 2) found.firstName = "Enter your first name.";
    if (!lastName.trim()) found.lastName = "Enter your last name.";
    if (!email.trim() && !(phone.trim() && messaging)) found.email = "Enter an email, or a phone number and agree to messages, so we can reach you.";
    else if (email.trim() && !/^\S+@\S+\.\S+$/.test(email.trim())) found.email = "Enter a valid email address.";
    if (phone.trim() && phone.trim().length < 8) found.phone = "Enter a valid phone number.";
    if (!dateFrom || dateFrom < today) found.dateFrom = "Choose a first day from today onwards.";
    if (!dateTo || dateTo < dateFrom) found.dateTo = "The last day must be on or after the first day.";
    else if (dateTo > latest) found.dateTo = `Choose a last day within the next ${WAITLIST_MAX_DAYS} days.`;
    if (!privacy) found.privacy = "Agree to this use of your details to join.";
    return found;
  }

  async function submit() {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setPending(true);
    try {
      const response = await fetch("/api/public/waitlist", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", ...bot.headers() },
        body: JSON.stringify({
          clinicSlug: clinic.slug, serviceId: service.id, locationId: location.id, practitionerIds: chosen, dateFrom, dateTo, timePreference,
          firstName: firstName.trim(), lastName: lastName.trim(), phone: phone.trim(), email: email.trim(),
          preferredChannel: phone.trim() && messaging ? "whatsapp" : "email", messagingConsent: Boolean(phone.trim()) && messaging, acceptedPrivacyNotice: true,
          [bookingBotFieldNames.honeypot]: honeypot.current?.value || undefined,
          [bookingBotFieldNames.fillMs]: openedAt.current === null ? undefined : Math.max(0, Date.now() - openedAt.current),
        }),
      });
      const body = (await response.json().catch(() => null)) as { data?: WaitlistJoinResult; error?: { code?: string; message?: string; fieldErrors?: Record<string, string[]> } } | null;
      if (!response.ok || !body?.data) {
        if (bot.afterResponse(body?.error?.code, body?.error?.fieldErrors?.turnstileToken?.[0])) return;
        const fields = body?.error?.fieldErrors ?? {};
        setErrors({
          form: body?.error?.message ?? "We could not add you to the waitlist. Please try again.",
          ...(fields.dateFrom?.[0] ? { dateFrom: fields.dateFrom[0] } : {}),
          ...(fields.dateTo?.[0] ? { dateTo: fields.dateTo[0] } : {}),
          ...(fields.email?.[0] ? { email: fields.email[0] } : {}),
        });
        return;
      }
      setDone(body.data);
    } catch {
      setErrors({ form: "We could not reach the server. Check your connection and try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2 rounded-xl border bg-muted/32 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-0.5">
        <p className="font-medium text-sm">No time suits you?</p>
        <p className="text-muted-foreground text-sm">{`Join the waitlist and ${clinic.name} will message you when ${t.aVisit} opens up.`}</p>
      </div>
      <Dialog open={open} onOpenChange={(next) => { if (!pending) setOpen(next); }}>
        <DialogTrigger render={<Button variant="outline" size="lg" className="w-full shrink-0 sm:w-auto" />}>
          <BellRing aria-hidden="true" /> Join the waitlist
        </DialogTrigger>
        <DialogPopup>
          {done ? (
            <>
              <DialogHeader>
                <DialogTitle>{done.updated ? "Your waitlist request is updated" : "You are on the waitlist"}</DialogTitle>
                <DialogDescription>We will message you if a matching time opens. You then have a few minutes to take it with one tap. Nothing is booked until you do.</DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <Alert variant="success" role="status"><CheckCircle2 aria-hidden="true" /><AlertDescription>{`${service.name} between ${dateFrom} and ${dateTo}.`}</AlertDescription></Alert>
              </DialogPanel>
              <DialogFooter><Button onClick={() => setOpen(false)}>Done</Button></DialogFooter>
            </>
          ) : (
            <Form className="contents" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
              <DialogHeader>
                <DialogTitle>Join the waitlist</DialogTitle>
                <DialogDescription>{`For ${service.name}. We will message you when a time opens, and you take it with one tap.`}</DialogDescription>
              </DialogHeader>
              <DialogPanel className="flex flex-col gap-5">
                {errors.form ? <Alert variant="error" role="alert"><TriangleAlert aria-hidden="true" /><AlertDescription>{errors.form}</AlertDescription></Alert> : null}
                {people.length > 1 ? (
                  <fieldset className="flex flex-col gap-2">
                    <legend className="font-medium text-sm">{`Who would you like to see?`}</legend>
                    <p className="text-muted-foreground text-xs">{`Leave all unticked for any ${t.practitioner}.`}</p>
                    {people.map((person) => (
                      <Label key={person.id} className="flex min-h-11 cursor-pointer items-center gap-3 sm:min-h-8">
                        <Checkbox checked={chosen.includes(person.id)} onCheckedChange={(checked) => setChosen((current) => checked ? [...current, person.id] : current.filter((id) => id !== person.id))} />
                        {person.name}
                      </Label>
                    ))}
                  </fieldset>
                ) : null}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <TextField id="waitlist-from" label="From" type="date" min={today} max={latest} value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} error={errors.dateFrom} />
                  <TextField id="waitlist-to" label="Until" type="date" min={dateFrom || today} max={latest} value={dateTo} onChange={(event) => setDateTo(event.target.value)} error={errors.dateTo} />
                </div>
                <fieldset className="flex flex-col gap-2">
                  <legend className="font-medium text-sm">Time of day</legend>
                  <RadioGroup value={timePreference} onValueChange={(next) => setTimePreference(next as TimePreference)} aria-label="Time of day" className="grid grid-cols-2 gap-2">
                    {timeChoices.map((choice) => (
                      <Label key={choice.value} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 has-data-checked:border-primary has-data-checked:bg-primary/4">
                        <Radio value={choice.value} className="mt-0.5" />
                        <span className="flex flex-col gap-0.5"><span>{choice.label}</span><span className="font-normal text-muted-foreground text-xs">{choice.hint}</span></span>
                      </Label>
                    ))}
                  </RadioGroup>
                </fieldset>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <TextField id="waitlist-first-name" label="First name" autoComplete="given-name" value={firstName} onChange={(event) => setFirstName(event.target.value)} error={errors.firstName} />
                  <TextField id="waitlist-last-name" label="Last name" autoComplete="family-name" value={lastName} onChange={(event) => setLastName(event.target.value)} error={errors.lastName} />
                </div>
                <TextField id="waitlist-email" label="Email" type="email" autoComplete="email" optional value={email} onChange={(event) => setEmail(event.target.value)} error={errors.email} />
                <PhoneField id="waitlist-phone" label="Phone" autoComplete="tel" optional value={phone} onChange={setPhone} error={errors.phone} />
                <div className="flex flex-col gap-3 border-t pt-4">
                  <Label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg sm:min-h-8">
                    <Checkbox className="mt-0.5" checked={messaging} onCheckedChange={(checked) => setMessaging(Boolean(checked))} />
                    <span className="flex flex-col gap-0.5">
                      <span>Message me on WhatsApp when a time opens</span>
                      <span className="font-normal text-muted-foreground text-xs">Needs a phone number. Otherwise we email you.</span>
                    </span>
                  </Label>
                  <div className="flex flex-col gap-1.5">
                    <Label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg sm:min-h-8">
                      <Checkbox className="mt-0.5" checked={privacy} onCheckedChange={(checked) => setPrivacy(Boolean(checked))} aria-invalid={Boolean(errors.privacy)} />
                      <span>{`I agree that ${clinic.name} keeps these details to offer me a time.`}</span>
                    </Label>
                    {errors.privacy ? <p role="alert" className="ps-7 text-destructive-foreground text-xs">{errors.privacy}</p> : null}
                  </div>
                </div>
                {/* Left empty by people (hidden from sight and from screen readers); bots that fill every field fill it. */}
                <div aria-hidden="true" className="pointer-events-none absolute -left-[10000px] h-px w-px overflow-hidden opacity-0">
                  <label htmlFor="waitlist-company-website">Company website</label>
                  <input ref={honeypot} id="waitlist-company-website" name={bookingBotFieldNames.honeypot} type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
                </div>
                {bot.shown && turnstileSiteKey ? <TurnstileField key={bot.round} siteKey={turnstileSiteKey} action="waitlist" onToken={bot.onToken} error={bot.error} /> : null}
              </DialogPanel>
              <DialogFooter>
                <Button type="button" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" loading={pending} disabled={bot.shown && Boolean(turnstileSiteKey) && !bot.token}>Join the waitlist</Button>
              </DialogFooter>
            </Form>
          )}
        </DialogPopup>
      </Dialog>
    </div>
  );
}
