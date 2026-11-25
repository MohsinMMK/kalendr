"use client";

import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { toastManager } from "@/components/ui/toast";
import { hasOptions, type FormField, type FormFieldType } from "@/lib/booking-forms";
import type { TermWords } from "@/lib/terminology";
import { routingLimits } from "@/lib/routing-forms";

import { moveBlocker, withoutConditionsOn } from "../booking-form-rules";
import { QuestionEditor } from "../booking-form-question-editor";
import { blankQuestion, moveItem, retargetRouteConditions, unsupportedTypes, withoutRouteRefsTo, type WorkingDraft } from "./builder-state";

/** Link names a booking question already uses, as buttons. Picking one shares the name, so the answer fills that booking question. */
function LinkNameHelp({ field, keys, disabled, customer, onPick }: { field: FormField; keys: readonly string[]; disabled: boolean; customer: string; onPick: (key: string) => void }) {
  if (field.prefillKey === undefined) return null;
  const taken = (field.prefillKey ?? "").toLowerCase();
  return (
    <div className="-mt-1 flex flex-col gap-2 rounded-lg border border-dashed p-3" role="group" aria-label={`Booking link name for ${field.label.trim() || "this question"}`}>
      <p className="text-muted-foreground text-xs">
        If a booking question uses the same link name, its answer is filled in on the booking page, so the {customer} is not asked twice.
      </p>
      {keys.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs">Names your booking questions use:</span>
          {keys.map((key) => (
            <Button key={key} type="button" size="sm" variant={key.toLowerCase() === taken ? "secondary" : "outline"} className="min-h-11 sm:min-h-8" disabled={disabled} aria-pressed={key.toLowerCase() === taken} onClick={() => onPick(key)}>{key}</Button>
          ))}
        </div>
      ) : <p className="text-muted-foreground text-xs">None of your booking questions use a link name yet.</p>}
    </div>
  );
}

export function QuestionsSection({ draft, bookingKeys, errors, disabled, terms, onChange }: {
  draft: WorkingDraft;
  bookingKeys: readonly string[];
  errors: Record<string, string>;
  disabled: boolean;
  terms: TermWords;
  onChange: (patch: Partial<Pick<WorkingDraft, "questions" | "routes">>) => void;
}) {
  const { questions } = draft;
  const atLimit = questions.length >= routingLimits.questions;

  function update(index: number, change: (field: FormField) => FormField) {
    const current = questions[index];
    if (!current) return;
    let next = change(current);
    // A routing question is always something the customer answers, so it can never be hidden.
    if (next.hidden) {
      const { hidden, ...rest } = next;
      void hidden;
      next = rest;
      toastManager.add({ title: "Routing questions cannot be hidden", description: "The customer answers every question on this form.", type: "info" });
    }
    onChange({ questions: questions.map((field, at) => (at === index ? next : field)) });
  }

  function changeType(index: number, type: FormFieldType) {
    if (unsupportedTypes.includes(type)) {
      toastManager.add({ title: "Pick another answer type", description: "Routing questions are plain questions the customer answers.", type: "warning" });
      return;
    }
    const current = questions[index];
    if (!current) return;
    const next: FormField = { ...current, type };
    if (hasOptions(type)) next.options = current.options && current.options.length > 0 ? current.options : ["", ""];
    else delete next.options;
    onChange({ questions: questions.map((field, at) => (at === index ? next : field)), routes: retargetRouteConditions(draft.routes, next) });
  }

  function move(index: number, by: -1 | 1) {
    const blocked = moveBlocker(questions, index, by);
    if (blocked) {
      toastManager.add({ title: "That question cannot move there", description: blocked, type: "warning" });
      return;
    }
    onChange({ questions: moveItem(questions, index, by) });
  }

  function remove(index: number) {
    const removed = questions[index];
    if (!removed) return;
    const stripped = withoutConditionsOn(questions.filter((_, at) => at !== index), removed.id);
    const routes = withoutRouteRefsTo(draft.routes, removed.id);
    if (stripped.changed > 0 || routes.changed > 0) toastManager.add({ title: "Rules that used this question were removed", type: "info" });
    onChange({ questions: stripped.fields, routes: routes.routes });
  }

  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>Questions</FrameTitle>
        <FrameDescription>{questions.length} of {routingLimits.questions} questions. Keep them short: each one is a chance for a {terms.customer} to give up.</FrameDescription>
      </FrameHeader>
      {questions.length === 0 ? <FramePanel><p className="text-muted-foreground text-sm">No questions yet. Add one below.</p></FramePanel> : null}
      {questions.map((field, index) => (
        <div key={field.id} className="flex flex-col gap-2">
          <QuestionEditor field={field} fields={questions} index={index} errors={errors} disabled={disabled}
            onChange={(change) => update(index, change)} onTypeChange={(type) => changeType(index, type)} onMove={(by) => move(index, by)} onRemove={() => remove(index)} />
          <LinkNameHelp field={field} keys={bookingKeys} disabled={disabled} customer={terms.customer} onPick={(key) => update(index, (before) => ({ ...before, prefillKey: key }))} />
        </div>
      ))}
      <FrameFooter className="flex flex-col gap-3">
        {errors.fields ? <p role="alert" className="text-destructive-foreground text-xs">{errors.fields}</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => onChange({ questions: [...questions, blankQuestion(questions)] })} disabled={disabled || atLimit}>
            <Plus aria-hidden="true" /> Add question
          </Button>
          {atLimit ? <p className="text-muted-foreground text-xs">A form can have up to {routingLimits.questions} questions.</p> : null}
        </div>
      </FrameFooter>
    </Frame>
  );
}
