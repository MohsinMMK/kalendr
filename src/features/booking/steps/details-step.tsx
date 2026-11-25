"use client";

import { ChevronDown, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";

import { PhoneField, SelectField, TextareaField, TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { TogglePrimitive } from "@/components/ui/toggle";
import { ToggleGroupPrimitive } from "@/components/ui/toggle-group";
import { contactRequirements, type IntakeSettings } from "@/lib/booking-intake";
import type { ContactChannel } from "@/lib/domain";

import { joinFullName, splitFullName } from "../full-name";
import { useTerms } from "../../terms/business-profile-context";
import { EmailList } from "../email-list";
import { ChoiceError, StepHeader } from "./step-header";

export interface DetailsValues {
  bookingFor?: "self" | "dependent";
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  dateOfBirth: string;
  reasonForVisit: string;
  preferredChannel: ContactChannel;
  messagingConsent: boolean;
  accessibilityNeed: string;
  acceptedPrivacyNotice: boolean;
}

const contactChannelOptions = [
  { value: "sms", label: "Text message (SMS)" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone call" },
];

/** Fields kept behind "Add a note or request" (or "Add more details"); an error in any of them opens it. */
const noteFields = ["dateOfBirth", "reasonForVisit", "accessibilityNeed", "preferredChannel"] as const;

/**
 * One "Full name" box. The booking keeps first and last name, so what is typed is split on the way out. The raw text
 * is held here so a trailing space survives while typing; a name that changes from outside (a returning customer's
 * saved one) replaces it.
 */
export function FullNameField({
  id = "first-name",
  fieldClassName = "col-span-2",
  firstName,
  lastName,
  label,
  error,
  autoComplete,
  onChange,
}: {
  id?: string;
  fieldClassName?: string;
  firstName: string;
  lastName: string;
  label: string;
  error?: string | undefined;
  autoComplete: string;
  onChange: (names: { firstName: string; lastName: string }) => void;
}) {
  const fromValues = joinFullName(firstName, lastName);
  const [text, setText] = useState(fromValues);
  if (joinFullName(text, "") !== fromValues) setText(fromValues);
  return (
    <TextField
      id={id}
      fieldClassName={fieldClassName}
      label={label}
      autoComplete={autoComplete}
      enterKeyHint="next"
      value={text}
      error={error}
      maxLength={160}
      onChange={(event) => {
        setText(event.target.value);
        onChange(splitFullName(event.target.value));
      }}
      required
    />
  );
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** "Last step: your details." Four fields, the optional note, reminders and the privacy tick. */
export function DetailsStep({
  values,
  errors,
  onChange,
  askBookingFor,
  askDateOfBirth,
  businessName,
  clinical,
  description,
  phoneHint,
  intake,
  guests,
  onGuestsChange,
  emailLocked = false,
  emailCheck,
}: {
  values: DetailsValues;
  errors: Record<string, string>;
  onChange: <Field extends keyof DetailsValues>(field: Field, value: DetailsValues[Field]) => void;
  askBookingFor: boolean;
  askDateOfBirth: boolean;
  businessName: string;
  clinical: boolean;
  /** The one helper line, for example that a request is confirmed later. */
  description?: string;
  /** A line under the phone field, for example that the team will call this number. */
  phoneHint?: string;
  /** How this service takes contact details, guests and the email check. */
  intake: IntakeSettings;
  /** Guest email addresses added so far. */
  guests: string[];
  onGuestsChange: (guests: string[]) => void;
  /** The booking link filled in the email, so it is shown read-only. */
  emailLocked?: boolean;
  /** The "Email check" block, shown under the email field when the service wants the address confirmed. */
  emailCheck?: ReactNode;
}) {
  const t = useTerms();
  const [noteOpen, setNoteOpen] = useState(false);
  const [guestsOpen, setGuestsOpen] = useState(false);
  const requirements = contactRequirements(intake.contactMode);
  const phoneOnly = requirements.email === "hidden";
  const channels = phoneOnly ? contactChannelOptions.filter((option) => option.value !== "email") : contactChannelOptions;
  const noteHasError = noteFields.some((field) => Boolean(errors[field]));
  const forSomeoneElse = askBookingFor && values.bookingFor === "dependent";

  return (
    <div className="flex flex-col gap-5">
      <StepHeader title="Last step: your details" description={description} />

      {askBookingFor ? (
        <div id="booking-for" tabIndex={-1} className="flex flex-col gap-2 outline-none">
          <p id="booking-for-label" className="font-medium text-sm">
            Who is the {t.appointment} for?
          </p>
          <SegmentedControl
            className="w-full sm:w-auto sm:self-start"
            render={
              <ToggleGroupPrimitive
                aria-labelledby="booking-for-label"
                aria-describedby={errors.bookingFor ? "booking-for-error" : undefined}
                value={values.bookingFor ? [values.bookingFor] : []}
                onValueChange={(next: string[]) => {
                  if (next[0]) onChange("bookingFor", next[0] as "self" | "dependent");
                }}
              />
            }
          >
            <SegmentedControlItem className="flex-1 sm:px-5" render={<TogglePrimitive value="self" />}>
              Myself
            </SegmentedControlItem>
            <SegmentedControlItem className="flex-1 sm:px-5" render={<TogglePrimitive value="dependent" />}>
              Someone else
            </SegmentedControlItem>
          </SegmentedControl>
          <ChoiceError id="booking-for-error" error={errors.bookingFor} />
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-x-3 gap-y-4">
        <FullNameField
          firstName={values.firstName}
          lastName={values.lastName}
          label={forSomeoneElse ? `${t.Customer}’s full name` : "Full name"}
          error={errors.firstName || errors.lastName || undefined}
          autoComplete={forSomeoneElse ? "off" : "name"}
          onChange={({ firstName, lastName }) => {
            if (firstName !== values.firstName) onChange("firstName", firstName);
            if (lastName !== values.lastName) onChange("lastName", lastName);
          }}
        />
        {requirements.atLeastOne ? (
          <p id="contact-legend" className="col-span-2 -mb-1 font-medium text-sm">Email or phone — at least one</p>
        ) : null}
        <PhoneField
          id="phone"
          fieldClassName={phoneOnly ? "col-span-2" : "col-span-2 md:col-span-1"}
          label={forSomeoneElse ? "Guardian or contact phone" : "Mobile number"}
          autoComplete="tel"
          value={values.phone}
          error={errors.phone}
          hint={phoneHint ?? (phoneOnly ? "We confirm and remind you by text or WhatsApp on this number." : undefined)}
          onChange={(next) => onChange("phone", next)}
          required={requirements.phone === "required"}
          optional={requirements.phone === "optional" && !requirements.atLeastOne}
        />
        {phoneOnly ? null : (
          <TextField
            id="email"
            fieldClassName="col-span-2 md:col-span-1"
            label={forSomeoneElse ? "Guardian or contact email" : "Email address"}
            type="email"
            inputMode="email"
            autoComplete="email"
            enterKeyHint="done"
            value={values.email}
            error={errors.email}
            readOnly={emailLocked}
            hint={emailLocked ? "Filled from your link" : undefined}
            onChange={(event) => onChange("email", event.target.value)}
            required={requirements.email === "required"}
            optional={requirements.email === "optional" && !requirements.atLeastOne}
          />
        )}
        {emailCheck}
      </div>

      {intake.allowGuests ? (
        <Collapsible open={guestsOpen || guests.length > 0 || Boolean(errors.guests)} onOpenChange={setGuestsOpen}>
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                className="-mx-2.5 h-auto min-h-11 w-[calc(100%+--spacing(5))] justify-between gap-3 whitespace-normal px-2.5 text-start"
              />
            }
          >
            <span>
              Add guests <span className="font-normal text-muted-foreground">(optional)</span>
              {guests.length > 0 ? <span className="ms-2 font-normal text-muted-foreground text-xs">{guests.length} added</span> : null}
            </span>
            <ChevronDown aria-hidden="true" className="text-muted-foreground transition-transform in-data-panel-open:rotate-180 motion-reduce:transition-none" />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div id="guests" className="flex flex-col gap-2 pt-3">
              <p id="guests-help" className="text-muted-foreground text-xs">
                Up to {intake.maxGuests} {intake.maxGuests === 1 ? "guest" : "guests"}. They get the confirmation and updates by email, and cannot change the {t.appointment}.
              </p>
              <EmailList
                id="guest"
                value={guests}
                onChange={onGuestsChange}
                max={intake.maxGuests}
                rowLabel="Guest email"
                addLabel="Add another guest"
                invalid={Boolean(errors.guests)}
                describedBy={errors.guests ? "guests-error" : "guests-help"}
              />
              {errors.guests ? <p id="guests-error" role="alert" className="text-destructive-foreground text-xs">{errors.guests}</p> : null}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}

      <Collapsible open={noteOpen || noteHasError} onOpenChange={setNoteOpen}>
        <CollapsibleTrigger
          render={
            <Button
              variant="ghost"
              className="-mx-2.5 h-auto min-h-11 w-[calc(100%+--spacing(5))] justify-between gap-3 whitespace-normal px-2.5 text-start"
            />
          }
        >
          <span>
            {askDateOfBirth ? "Add more details" : "Add a note or request"}{" "}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </span>
          <ChevronDown aria-hidden="true" className="text-muted-foreground transition-transform in-data-panel-open:rotate-180 motion-reduce:transition-none" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="flex flex-col gap-4 pt-3">
            {askDateOfBirth ? (
              <TextField
                id="date-of-birth"
                label={forSomeoneElse ? `${t.Customer}’s date of birth` : "Date of birth"}
                optional
                type="date"
                autoComplete={forSomeoneElse ? "off" : "bday"}
                min="1900-01-01"
                max={todayIsoDate()}
                value={values.dateOfBirth}
                error={errors.dateOfBirth}
                hint={`Helps the ${t.business} find the right record.`}
                onChange={(event) => onChange("dateOfBirth", event.target.value)}
              />
            ) : null}
            <TextareaField
              id="reason-for-visit"
              label={`What is the ${t.visit} for?`}
              optional
              value={values.reasonForVisit}
              maxLength={300}
              error={errors.reasonForVisit}
              hint={
                clinical
                  ? "A few words, for example “check-up” or “tooth pain on the left”. Don’t include medical history."
                  : "A few words about what you would like help with."
              }
              onChange={(event) => onChange("reasonForVisit", event.target.value)}
            />
            <TextareaField
              id="accessibility-need"
              label="Accessibility or communication needs"
              optional
              value={values.accessibilityNeed}
              maxLength={300}
              hint={
                clinical
                  ? "For example, step-free access, extra time, or an interpreter. Do not include clinical history."
                  : "For example, step-free access, extra time, or an interpreter."
              }
              error={errors.accessibilityNeed}
              onChange={(event) => onChange("accessibilityNeed", event.target.value)}
            />
            <SelectField
              id="preferred-channel"
              label={`How should the ${t.business} contact you?`}
              value={values.preferredChannel}
              error={errors.preferredChannel}
              options={channels}
              onValueChange={(value) => onChange("preferredChannel", value as ContactChannel)}
            />
          </div>
        </CollapsiblePanel>
      </Collapsible>

      <div className="flex flex-col gap-3 border-t pt-4">
        <div className="flex flex-col gap-1.5">
          <Label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg sm:min-h-8">
            <Checkbox
              id="messaging-consent"
              className="mt-0.5"
              checked={values.messagingConsent}
              onCheckedChange={(checked) => onChange("messagingConsent", checked)}
              aria-invalid={Boolean(errors.messagingConsent)}
              aria-describedby={errors.messagingConsent ? "messaging-consent-error" : undefined}
            />
            <span className="flex flex-col gap-0.5">
              <span>{phoneOnly ? "Send confirmations and reminders by text message or WhatsApp" : "Send reminders by text message or WhatsApp"}</span>
              <span className="font-normal text-muted-foreground text-xs">
                {phoneOnly
                  ? `We have no email for you, so this is how ${businessName} reaches you.`
                  : `Otherwise ${businessName} sends reminders by email.`}
              </span>
            </span>
          </Label>
          <div className="ps-7">
            <ChoiceError id="messaging-consent-error" error={errors.messagingConsent} />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg sm:min-h-8">
            <Checkbox
              id="privacy-notice"
              className="mt-0.5"
              checked={values.acceptedPrivacyNotice}
              onCheckedChange={(checked) => onChange("acceptedPrivacyNotice", checked)}
              aria-invalid={Boolean(errors.acceptedPrivacyNotice)}
              aria-describedby={errors.acceptedPrivacyNotice ? "privacy-notice-error" : undefined}
            />
            <span>I understand and agree to this use of the booking details.</span>
          </Label>
          <Collapsible className="ps-7">
            <CollapsibleTrigger render={<Button variant="link" size="sm" className="h-auto min-h-8 px-0" />}>
              Read the privacy notice
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <p className="flex gap-2 pt-1 pb-1 text-muted-foreground text-sm">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success-foreground" aria-hidden="true" />
                <span>
                  Kalendr shares these scheduling details with {businessName}. They are used to arrange and communicate about this {t.appointment}. Avoid entering sensitive {clinical ? "clinical" : "personal"} information here.
                </span>
              </p>
            </CollapsiblePanel>
          </Collapsible>
          <div className="ps-7">
            <ChoiceError id="privacy-notice-error" error={errors.acceptedPrivacyNotice} />
          </div>
        </div>
      </div>
    </div>
  );
}
