"use client";

import { useEffect, useState } from "react";

import { Frame, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Skeleton } from "@/components/ui/skeleton";
import { formatFormAnswer, type FormAnswers, type FormField } from "@/lib/booking-forms";

interface FormAnswersView {
  name: string;
  fields: FormField[];
  answers: FormAnswers;
}

type LoadState = { status: "loading" } | { status: "ready"; form: FormAnswersView | null } | { status: "failed" };

/** What the customer answered on the business's booking form. Shows nothing when the booking had no form. */
export function BookingFormAnswers({ appointmentId }: { appointmentId: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    const abort = new AbortController();
    fetch(`/api/staff/appointments/${encodeURIComponent(appointmentId)}/form`, { signal: abort.signal, headers: { Accept: "application/json" } })
      .then(async (response) => {
        // An appointment that only exists in this browser's preview has no stored answers.
        if (response.status === 404) return setState({ status: "ready", form: null });
        if (!response.ok) throw new Error("Could not load the answers.");
        const payload = (await response.json()) as { data?: FormAnswersView | null };
        setState({ status: "ready", form: payload.data ?? null });
      })
      .catch(() => {
        if (!abort.signal.aborted) setState({ status: "failed" });
      });
    return () => abort.abort();
  }, [appointmentId]);

  if (state.status === "ready" && !state.form) return null;

  return (
    <section aria-label="Booking form answers" className="lg:col-start-1">
      <Frame>
        <FrameHeader className="px-3 py-2">
          <h2 className="text-sm font-medium">{state.status === "ready" && state.form ? state.form.name : "Booking form"}</h2>
        </FrameHeader>
        <FramePanel className="p-4">
          {state.status === "loading" ? (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading answers">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : state.status === "failed" ? (
            <p className="text-sm text-muted-foreground">The answers could not be loaded. Refresh the page to try again.</p>
          ) : (
            <dl className="grid gap-4 sm:grid-cols-2">
              {state.form!.fields.map((field) => (
                <div key={field.id} className="min-w-0 sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">{field.label}</dt>
                  <dd className="mt-0.5 whitespace-pre-wrap break-words text-sm">{formatFormAnswer(field, state.form!.answers[field.id])}</dd>
                </div>
              ))}
            </dl>
          )}
        </FramePanel>
      </Frame>
    </section>
  );
}
