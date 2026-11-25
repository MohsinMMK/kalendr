"use client";

import { Check, Minus, TriangleAlert, X } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerDescription, DrawerHeader, DrawerPanel, DrawerPopup, DrawerTitle } from "@/components/ui/drawer";
import { BookingFormQuestion } from "@/features/booking/booking-form-question";
import { conditionOperatorLabels, isFieldVisible, type FormAnswer, type FormAnswers, type FormField } from "@/lib/booking-forms";
import type { TermWords } from "@/lib/terminology";
import type { Destination, PreviewResult, RoutingBuilderOptions } from "@/lib/routing-forms";

import { StaffApiError } from "../queries/http";
import { usePreviewRouting } from "./queries";

export function destinationText(destination: Destination, options: RoutingBuilderOptions | undefined, terms: Pick<TermWords, "service">): string {
  if (destination.type === "external") return `Goes to ${destination.url}`;
  if (destination.type === "message") return `Shows the message “${destination.title}”`;
  const name = options?.services.find((entry) => entry.id === destination.serviceId)?.name ?? `a ${terms.service}`;
  return `Books ${name}`;
}

function Trace({ result }: { result: PreviewResult }) {
  return (
    <ol aria-label="Route by route" className="flex flex-col gap-2">
      {result.trace.routes.map((route) => (
        <li key={route.routeId} className="flex flex-col gap-1 rounded-lg border p-3">
          <p className="flex flex-wrap items-center gap-2 font-medium text-sm">
            {route.name}
            {route.matched && !route.skipped ? <Badge variant="success"><Check aria-hidden="true" />Matched</Badge> : route.skipped ? <Badge variant="warning"><TriangleAlert aria-hidden="true" />Fits, but nobody to offer</Badge> : <Badge variant="secondary"><Minus aria-hidden="true" />Did not match</Badge>}
          </p>
          {route.conditions.length === 0 ? <p className="text-muted-foreground text-xs">No conditions: matches everyone.</p> : (
            <ul className="flex flex-col gap-0.5">
              {route.conditions.map((condition, at) => (
                <li key={at} className="flex items-start gap-2 text-xs">
                  {condition.passed ? <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /> : <X aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />}
                  <span><span className="sr-only">{condition.passed ? "Passed: " : "Did not pass: "}</span>{condition.label} {conditionOperatorLabels[condition.operator]} {[condition.expected].flat().join(" or ")}</span>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
      <li className="rounded-lg border p-3 text-xs"><span className="font-medium text-sm">Fallback</span>{result.routeId === "fallback" ? <Badge variant="success" className="ms-2"><Check aria-hidden="true" />Used</Badge> : <span className="ms-2 text-muted-foreground">Not needed</span>}</li>
    </ol>
  );
}

function Outcome({ result, options, terms }: { result: PreviewResult; options: RoutingBuilderOptions | undefined; terms: TermWords }) {
  return (
    <section aria-label="Preview result" className="flex flex-col gap-4">
      <Alert variant="info">
        <AlertTitle>Matched: {result.routeName}</AlertTitle>
        <AlertDescription>{destinationText(result.destination, options, terms)}.</AlertDescription>
      </Alert>
      {result.destination.type === "service" ? (
        <div className="flex flex-col gap-2">
          <h3 className="font-medium text-sm">{terms.Providers} who would be offered</h3>
          {result.offered.length === 0 ? (
            <Alert variant="warning"><TriangleAlert aria-hidden="true" /><AlertDescription>Nobody fits these answers. The next route would be tried.</AlertDescription></Alert>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {result.offered.map((person) => (
                <li key={person.personId} className="flex min-h-11 items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span>{person.name}</span>
                  <span className="text-muted-foreground text-xs tabular-nums">{person.multiplier > 1 ? `Counts ${person.multiplier} times` : "Counts once"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <h3 className="font-medium text-sm">How we got there</h3>
        <Trace result={result} />
      </div>
    </section>
  );
}

/** Fill in the questions and see which route would match. It runs on the saved form and saves nothing. */
export function PreviewPanel({ formId, questions, options, terms, open, onOpenChange }: {
  formId: string; questions: readonly FormField[]; options: RoutingBuilderOptions | undefined; terms: TermWords; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const [answers, setAnswers] = useState<FormAnswers>({});
  const preview = usePreviewRouting(formId);
  const fieldErrors = preview.error instanceof StaffApiError ? preview.error.fieldErrors : {};
  const visible = questions.filter((field) => !field.hidden && isFieldVisible(field, answers, questions));
  function set(field: FormField, value: FormAnswer | undefined) {
    setAnswers((before) => {
      const next = { ...before };
      if (value === undefined) delete next[field.id]; else next[field.id] = value;
      return next;
    });
  }
  return (
    <Drawer open={open} onOpenChange={onOpenChange} position="right">
      <DrawerPopup showBar>
        <DrawerHeader>
          <DrawerTitle>Try the form</DrawerTitle>
          <DrawerDescription>Answer as a {terms.customer} would. Nothing is saved and nobody is booked.</DrawerDescription>
        </DrawerHeader>
        <DrawerPanel className="flex flex-col gap-5">
          <form className="flex flex-col gap-4" noValidate onSubmit={(event) => { event.preventDefault(); preview.mutate(answers); }}>
            {visible.map((field) => (
              <BookingFormQuestion key={field.id} field={field} idPrefix="routing-preview" value={answers[field.id]} onChange={(value) => set(field, value)} error={fieldErrors[field.id]?.[0]} />
            ))}
            <div><Button type="submit" className="min-h-11 sm:min-h-9" loading={preview.isPending}>Show the result</Button></div>
          </form>
          {preview.isError && Object.keys(fieldErrors).length === 0 ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{preview.error instanceof Error ? preview.error.message : "The preview could not run."}</AlertDescription></Alert> : null}
          {preview.data ? <Outcome result={preview.data} options={options} terms={terms} /> : null}
        </DrawerPanel>
      </DrawerPopup>
    </Drawer>
  );
}
