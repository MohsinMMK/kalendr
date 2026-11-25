"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { MessageSquareTextIcon, TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import { BookingFormQuestion } from "@/features/booking/booking-form-question";
import { pruneAnswers } from "@/features/booking/booking-answers";
import { checkFormAnswers, isFieldVisible, type FormAnswer, type FormAnswers } from "@/lib/booking-forms";
import type { PublicRoutingForm, RoutingOutcome } from "@/lib/routing-forms";

const ID_PREFIX = "routing";
const rateLimitText = "Too many tries. Please wait a moment and try again.";
const failureText = "We could not send your answers. Check your connection and try again.";

type Message = Extract<RoutingOutcome, { type: "message" }>;

interface Failure {
  kind: "rate_limit" | "error";
  text: string;
}

function readError(body: unknown): { message: string | null; fieldErrors: Record<string, string> } {
  const fieldErrors: Record<string, string> = {};
  let message: string | null = null;
  if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null) {
    const error = body.error as { message?: unknown; fieldErrors?: unknown };
    if (typeof error.message === "string") message = error.message;
    if (error.fieldErrors && typeof error.fieldErrors === "object") {
      for (const [id, entry] of Object.entries(error.fieldErrors as Record<string, unknown>)) {
        if (Array.isArray(entry) && typeof entry[0] === "string") fieldErrors[id] = entry[0];
      }
    }
  }
  return { message, fieldErrors };
}

function readOutcome(body: unknown): RoutingOutcome | null {
  const data = typeof body === "object" && body !== null && "data" in body ? (body as { data: unknown }).data : null;
  if (typeof data !== "object" || data === null || !("type" in data)) return null;
  const outcome = data as Partial<RoutingOutcome> & { type: string };
  if ((outcome.type === "booking" || outcome.type === "external") && "url" in outcome && typeof outcome.url === "string") return outcome as RoutingOutcome;
  if (outcome.type === "message" && "title" in outcome && "body" in outcome) return outcome as RoutingOutcome;
  return null;
}

/**
 * A business's routing form (feature 46): a few questions on one screen, then the customer goes to the right booking
 * page, another website, or sees a message. Nothing here says who was matched or why.
 */
export function RoutingForm({ clinicSlug, formSlug, form }: { clinicSlug: string; formSlug: string; form: PublicRoutingForm }) {
  const [answers, setAnswers] = useState<FormAnswers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const token = useRef<string | null>(null);
  const focusErrors = useRef(false);
  const messageHeading = useRef<HTMLHeadingElement>(null);
  const base = `/api/public/routing/${encodeURIComponent(clinicSlug)}/${encodeURIComponent(formSlug)}`;

  // Opening the form starts the funnel. A failure is ignored: answers can still be sent without a token.
  useEffect(() => {
    const abort = new AbortController();
    fetch(`${base}/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: abort.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        const data = typeof body === "object" && body !== null && "data" in body ? (body as { data: unknown }).data : null;
        if (typeof data === "object" && data !== null && "token" in data && typeof data.token === "string") token.current = data.token;
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [base]);

  // Only a failed Continue moves focus; fixing a field never pulls the customer out of it.
  useEffect(() => {
    if (!focusErrors.current || Object.keys(errors).length === 0) return;
    focusErrors.current = false;
    const first = form.questions.find((field) => errors[field.id]);
    if (!first) return;
    const target = document.getElementById(`${ID_PREFIX}-${first.id}`);
    (target?.querySelector<HTMLElement>("input, textarea, button, [role='combobox']") ?? target)?.focus();
  }, [errors, form.questions]);

  useEffect(() => {
    if (message) messageHeading.current?.focus();
  }, [message]);

  function change(id: string, value: FormAnswer | undefined) {
    setAnswers((current) => {
      const next = { ...current };
      if (value === undefined) delete next[id];
      else next[id] = value;
      return next;
    });
    setErrors((current) => {
      if (!current[id]) return current;
      const rest = { ...current };
      delete rest[id];
      return rest;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const check = checkFormAnswers(form.questions, pruneAnswers(form.questions, answers));
    if (!check.ok) {
      focusErrors.current = true;
      setErrors(check.errors);
      return;
    }
    setBusy(true);
    setFailure(null);
    let leaving = false;
    try {
      const response = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: check.answers, ...(token.current ? { responseToken: token.current } : {}) }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 429) {
        setFailure({ kind: "rate_limit", text: readError(body).message ?? rateLimitText });
        return;
      }
      if (!response.ok) {
        const { message: text, fieldErrors } = readError(body);
        if (Object.keys(fieldErrors).length > 0) {
          focusErrors.current = true;
          setErrors(fieldErrors);
        } else {
          setFailure({ kind: "error", text: text ?? failureText });
        }
        return;
      }
      const outcome = readOutcome(body);
      if (!outcome) {
        setFailure({ kind: "error", text: failureText });
        return;
      }
      if (outcome.type === "message") {
        setMessage(outcome);
        return;
      }
      // Stay busy: the browser is already on its way, and a second send would only make a second response.
      leaving = true;
      window.location.assign(outcome.url);
    } catch {
      setFailure({ kind: "error", text: failureText });
    } finally {
      if (!leaving) setBusy(false);
    }
  }

  if (message) {
    return (
      <div className="mx-auto w-full max-w-xl py-4 sm:py-0">
        <Card>
          <CardPanel className="flex flex-col items-start gap-3 p-5">
            <MessageSquareTextIcon aria-hidden="true" className="size-6 text-muted-foreground" />
            <h1 ref={messageHeading} tabIndex={-1} className="font-semibold text-xl outline-none">{message.title}</h1>
            <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
          </CardPanel>
        </Card>
      </div>
    );
  }

  const shown = form.questions.filter((field) => isFieldVisible(field, answers, form.questions));
  const errorCount = Object.keys(errors).length;

  return (
    <div className="mx-auto w-full max-w-xl py-4 sm:py-0">
      <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-6" aria-busy={busy || undefined}>
        <div className="flex flex-col gap-2">
          <h1 className="font-semibold text-2xl">{form.name}</h1>
          {form.intro ? <p className="whitespace-pre-wrap text-muted-foreground text-sm">{form.intro}</p> : null}
        </div>
        {errorCount > 0 ? (
          <Alert variant="error" role="alert">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertTitle>{errorCount === 1 ? "One answer needs a fix" : `${errorCount} answers need a fix`}</AlertTitle>
          </Alert>
        ) : null}
        <div className="flex flex-col gap-5">
          {shown.map((field) => (
            <BookingFormQuestion
              key={field.id}
              field={field}
              idPrefix={ID_PREFIX}
              value={answers[field.id]}
              error={errors[field.id]}
              onChange={(value) => change(field.id, value)}
              disabled={busy}
            />
          ))}
        </div>
        {failure ? (
          <Alert variant="error" role="alert">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertTitle>{failure.kind === "rate_limit" ? "Please wait a moment" : "Something went wrong"}</AlertTitle>
            <AlertDescription>{failure.text}</AlertDescription>
          </Alert>
        ) : null}
        <Button type="submit" size="lg" className="min-h-11 w-full sm:w-auto sm:self-start" loading={busy}>
          {failure ? "Try again" : "Continue"}
        </Button>
      </form>
    </div>
  );
}
