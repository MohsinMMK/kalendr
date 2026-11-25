"use client";

import { CalendarCheck, Globe, MessageSquare } from "lucide-react";
import type { ReactNode } from "react";

import { OptionSelect, TextField, TextareaField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { FormField } from "@/lib/booking-forms";
import type { TermWords } from "@/lib/terminology";
import { routingLimits, type Destination, type DestinationType, type RoutingBuilderOptions } from "@/lib/routing-forms";

import { defaultDestination } from "./builder-state";
import { PeopleRuleEditor } from "./people-rule-editor";

export interface DestinationEditorProps {
  idPrefix: string;
  destination: Destination;
  options: RoutingBuilderOptions;
  questions: readonly FormField[];
  /** The fallback cannot depend on an answer. */
  isFallback: boolean;
  /** Where this destination's errors are reported, such as `routes.2.destination` or `fallback`. */
  errorBase: string;
  errors: Record<string, string>;
  disabled: boolean;
  terms: TermWords;
  onChange: (destination: Destination) => void;
}

function kinds(terms: TermWords): Array<{ value: DestinationType; label: string; hint: string; icon: ReactNode }> {
  return [
    { value: "service", label: `Book a ${terms.service}`, hint: `Send them to the booking page for one ${terms.service}`, icon: <CalendarCheck aria-hidden="true" className="size-4" /> },
    { value: "external", label: "Go to another website", hint: "Send them to a web address you choose", icon: <Globe aria-hidden="true" className="size-4" /> },
    { value: "message", label: "Show a message", hint: "Show a heading and a few words, such as “We will call you”", icon: <MessageSquare aria-hidden="true" className="size-4" /> },
  ];
}

export function DestinationEditor(props: DestinationEditorProps) {
  const { idPrefix, destination, options, questions, isFallback, errorBase, errors, disabled, terms, onChange } = props;
  const items = kinds(terms);
  const service = destination.type === "service" ? options.services.find((entry) => entry.id === destination.serviceId) : undefined;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-kind`}>{isFallback ? "If nothing matches, then" : "Then"}</Label>
        <Select items={items.map((item) => ({ value: item.value, label: item.label }))} value={destination.type} disabled={disabled}
          onValueChange={(next) => { if (next && next !== destination.type) onChange(defaultDestination(next as DestinationType, options)); }}>
          <SelectTrigger id={`${idPrefix}-kind`} size="lg"><SelectValue /></SelectTrigger>
          <SelectPopup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                <span className="flex items-start gap-2">{item.icon}<span className="flex min-w-0 flex-col"><span>{item.label}</span><span className="text-muted-foreground text-xs">{item.hint}</span></span></span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {destination.type === "service" ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-service`}>{terms.Service}</Label>
            <OptionSelect id={`${idPrefix}-service`} value={destination.serviceId} placeholder={`Choose a ${terms.service}`} disabled={disabled}
              options={options.services.map((entry) => ({ value: entry.id, label: `${entry.name}${entry.active ? entry.hidden ? " (hidden)" : "" : " (turned off)"}` }))}
              onValueChange={(serviceId) => onChange({ ...destination, serviceId })} />
            {errors[`${errorBase}.serviceId`] ? <p role="alert" className="text-destructive-foreground text-xs">{errors[`${errorBase}.serviceId`]}</p> : null}
          </div>
          {service && !service.active ? <Alert variant="warning"><AlertDescription>{service.name} is turned off, so nobody can book it.</AlertDescription></Alert> : null}
          <PeopleRuleEditor rule={destination.people} options={options} questions={questions} fixedOnly={isFallback} idPrefix={idPrefix} errors={errors} errorBase={errorBase} disabled={disabled} terms={terms}
            onChange={(people) => onChange({ ...destination, people })} />
        </>
      ) : null}
      {destination.type === "external" ? (
        <TextField label="Web address" hint="Starts with https://" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={destination.url} maxLength={routingLimits.url}
          error={errors[`${errorBase}.url`]} disabled={disabled} onChange={(event) => onChange({ ...destination, url: event.target.value })} />
      ) : null}
      {destination.type === "message" ? (
        <>
          <TextField label="Message heading" value={destination.title} maxLength={120} error={errors[`${errorBase}.title`]} disabled={disabled} onChange={(event) => onChange({ ...destination, title: event.target.value })} />
          <TextareaField label="Message" value={destination.body} maxLength={routingLimits.message} error={errors[`${errorBase}.body`]} disabled={disabled} onChange={(event) => onChange({ ...destination, body: event.target.value })} />
        </>
      ) : null}
    </div>
  );
}
