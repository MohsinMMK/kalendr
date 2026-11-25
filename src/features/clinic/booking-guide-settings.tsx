"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ExternalLink, ListChecks, Plus, Sparkles, Trash2, X } from "lucide-react";

import { TextField, TextareaField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxGroup } from "@/components/ui/checkbox-group";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Label } from "@/components/ui/label";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { GuideQuestionChoices } from "@/features/business/guide-question";
import {
  bookingGuideSchema,
  guideLimits,
  matchGuide,
  newGuideId,
  starterGuide,
  type BookingGuide,
  type GuideAnswers,
  type GuideOption,
  type GuideQuestion,
} from "@/lib/booking-guide";

import { useBusinessProfile, useTerms } from "../terms/business-profile-context";
import { useCatalogLookups } from "./clinic-catalog";
import { useStaffAccess } from "./staff-access";
import { staffMutation, staffQuery } from "./staff-snapshot-provider";

function blankOption(existing: readonly GuideOption[]): GuideOption {
  return { id: newGuideId("a", existing), label: "", serviceIds: [] };
}

function blankQuestion(existing: readonly GuideQuestion[]): GuideQuestion {
  const first = blankOption([]);
  return { id: newGuideId("q", existing), label: "", multiple: false, options: [first, blankOption([first])] };
}

/** Error messages keyed by zod path, such as `questions.0.options.1.label`. The first message for a path wins. */
function errorsByPath(draft: BookingGuide): { errors: Record<string, string>; first: string } {
  const result = bookingGuideSchema.safeParse(draft);
  if (result.success) return { errors: {}, first: "" };
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const path = issue.path.join(".");
    errors[path] ??= issue.message;
  }
  return { errors, first: result.error.issues[0]?.message ?? "Check the questions and try again." };
}

/**
 * Settings → Help me choose. A few questions customers answer before they pick who to book; each answer
 * points at the services it fits. Owners and admins edit them.
 */
export function BookingGuideSettings() {
  const profile = useBusinessProfile();
  const t = useTerms();
  const access = useStaffAccess();
  const catalog = useCatalogLookups();
  const canChange = access.role === "owner" || access.role === "admin";

  const [saved, setSaved] = useState<BookingGuide | null>(null);
  const [draft, setDraft] = useState<BookingGuide | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadState("loading");
    setLoadError("");
    try {
      const { guide } = await staffQuery<{ guide: BookingGuide | null }>("/api/staff/guide", signal);
      setSaved(guide);
      setDraft(guide);
      setLoadState("ready");
    } catch (cause: unknown) {
      if (signal?.aborted) return;
      setLoadError(cause instanceof Error ? cause.message : "The questions could not be loaded.");
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => void load(controller.signal));
    return () => controller.abort();
  }, [load]);

  const readOnlyNote = !canChange ? (
    <Alert role="note">
      <AlertDescription>Only the owner or an admin can change these questions.</AlertDescription>
    </Alert>
  ) : null;

  if (loadState === "loading") {
    return (
      <div role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" /> Loading the questions…
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <Alert variant="error">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          <span>{loadError}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!draft) {
    return (
      <div className="flex flex-col gap-4">
        {readOnlyNote}
        <Frame>
          <FramePanel>
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><ListChecks aria-hidden="true" /></EmptyMedia>
                <EmptyTitle>No questions yet</EmptyTitle>
                <EmptyDescription>
                  Ask {t.customers} a few questions and show them only the {t.services} and {t.providers} that fit.
                  They can always skip the questions and see everything.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent className="flex flex-row flex-wrap justify-center gap-2">
                <Button onClick={() => setDraft(starterGuide(profile.businessType, catalog.services))} disabled={!canChange || catalog.services.length === 0}>
                  <Sparkles aria-hidden="true" /> Start from suggested questions
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setDraft({ isActive: true, title: "Help me choose", intro: "", questions: [blankQuestion([])] })}
                  disabled={!canChange}
                >
                  Start from scratch
                </Button>
              </EmptyContent>
              {catalog.services.length === 0 ? (
                <p className="text-muted-foreground text-xs">Add {t.services} first to get suggested questions.</p>
              ) : null}
            </Empty>
          </FramePanel>
        </Frame>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {readOnlyNote}
      <GuideEditor
        key={saved ? "saved" : "new"}
        initial={draft}
        isNew={!saved}
        canChange={canChange}
        onCancel={() => setDraft(saved)}
        onSaved={(guide) => {
          setSaved(guide);
          setDraft(guide);
          toastManager.add({ title: "Questions saved.", type: "success" });
        }}
      />
    </div>
  );
}

interface GuideEditorProps {
  initial: BookingGuide;
  isNew: boolean;
  canChange: boolean;
  onCancel: () => void;
  onSaved: (guide: BookingGuide) => void;
}

function GuideEditor({ initial, isNew, canChange, onCancel, onSaved }: GuideEditorProps) {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const [draft, setDraft] = useState<BookingGuide>(initial);
  const [showErrors, setShowErrors] = useState(false);
  const [pending, setPending] = useState(false);
  const [serverMessage, setServerMessage] = useState("");
  const [answers, setAnswers] = useState<GuideAnswers>({});

  const check = errorsByPath(draft);
  const errors = showErrors ? check.errors : {};
  const message = serverMessage || (showErrors ? check.first : "");
  const disabled = !canChange || pending;
  const atLimit = draft.questions.length >= guideLimits.questions;

  function update(patch: Partial<BookingGuide>) {
    setServerMessage("");
    setDraft((before) => ({ ...before, ...patch }));
  }

  function updateQuestion(index: number, change: (question: GuideQuestion) => GuideQuestion) {
    setServerMessage("");
    setDraft((before) => ({ ...before, questions: before.questions.map((question, at) => (at === index ? change(question) : question)) }));
  }

  function moveQuestion(index: number, by: -1 | 1) {
    setDraft((before) => {
      const target = index + by;
      if (target < 0 || target >= before.questions.length) return before;
      const questions = [...before.questions];
      [questions[index], questions[target]] = [questions[target], questions[index]];
      return { ...before, questions };
    });
  }

  async function save() {
    setShowErrors(true);
    setServerMessage("");
    const result = bookingGuideSchema.safeParse(draft);
    if (!result.success) return;
    setPending(true);
    try {
      const { guide } = await staffMutation<{ guide: BookingGuide }>("/api/staff/guide", "PATCH", result.data);
      setDraft(guide);
      setShowErrors(false);
      onSaved(guide);
    } catch (cause: unknown) {
      setServerMessage(cause instanceof Error ? cause.message : "The questions could not be saved.");
    } finally {
      setPending(false);
    }
  }

  const previewQuestions = draft.questions.map((question) => ({
    ...question,
    label: question.label.trim() || "Untitled question",
    options: question.options.map((option, at) => ({ ...option, label: option.label.trim() || `Answer ${at + 1}` })),
  }));
  const match = matchGuide({ ...draft, questions: previewQuestions }, answers, catalog.services, catalog.practitioners);
  const findHref = `/b/${encodeURIComponent(catalog.clinic.slug)}/find`;

  return (
    <form
      className="@container flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      noValidate
    >
      <div className="grid items-start gap-4 @3xl:grid-cols-[minmax(0,1fr)_18rem] @4xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Frame>
            <FrameHeader className="flex-row flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1 basis-64">
                <FrameTitle className="flex flex-wrap items-center gap-2">
                  Help me choose
                  <Badge variant={draft.isActive ? "success" : "outline"}>{draft.isActive ? "On" : "Off"}</Badge>
                </FrameTitle>
                <FrameDescription>
                  {t.Customers} answer these questions on your page, then see the {t.providers} and {t.services} that fit.
                </FrameDescription>
              </div>
              {!isNew && draft.isActive ? (
                <Button variant="outline" size="sm" render={<Link href={findHref} target="_blank" rel="noreferrer" />}>
                  <ExternalLink aria-hidden="true" /> Open it
                </Button>
              ) : null}
            </FrameHeader>
            <FramePanel className="flex flex-col gap-4">
              <TextField
                label="Title"
                hint={`The name of the button on your page and the heading ${t.customers} see first.`}
                value={draft.title}
                onChange={(event) => update({ title: event.target.value })}
                maxLength={guideLimits.title}
                error={errors.title}
                disabled={disabled}
              />
              <TextareaField
                label="Short introduction"
                optional
                value={draft.intro}
                onChange={(event) => update({ intro: event.target.value })}
                maxLength={guideLimits.intro}
                error={errors.intro}
                disabled={disabled}
              />
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <Label htmlFor="booking-guide-active" className="font-medium">{t.Customers} see these questions</Label>
                  <p className="text-xs text-muted-foreground">Turn it off to hide the questions without losing them.</p>
                </div>
                <Switch
                  id="booking-guide-active"
                  checked={draft.isActive}
                  onCheckedChange={(on) => update({ isActive: on })}
                  disabled={disabled}
                />
              </div>
            </FramePanel>
          </Frame>

          <Frame>
            <FrameHeader>
              <FrameTitle>Questions</FrameTitle>
              <FrameDescription>
                {draft.questions.length} of {guideLimits.questions} questions, asked one at a time in this order.
                For each answer, tick the {t.services} it fits.
              </FrameDescription>
            </FrameHeader>
            {draft.questions.length === 0 ? (
              <FramePanel>
                <p className="text-sm text-muted-foreground">No questions yet. Add one below.</p>
              </FramePanel>
            ) : null}
            {draft.questions.map((question, index) => (
              <QuestionEditor
                key={question.id}
                question={question}
                index={index}
                count={draft.questions.length}
                errors={errors}
                disabled={disabled}
                onChange={(change) => updateQuestion(index, change)}
                onMove={(by) => moveQuestion(index, by)}
                onRemove={() => setDraft((before) => ({ ...before, questions: before.questions.filter((_, at) => at !== index) }))}
              />
            ))}
            <FrameFooter className="flex flex-col gap-3">
              {errors.questions ? <p className="text-xs text-destructive-foreground">{errors.questions}</p> : null}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDraft((before) => (before.questions.length >= guideLimits.questions ? before : { ...before, questions: [...before.questions, blankQuestion(before.questions)] }))}
                  disabled={disabled || atLimit}
                >
                  <Plus aria-hidden="true" /> Add question
                </Button>
                {atLimit ? <p className="text-xs text-muted-foreground">You can ask up to {guideLimits.questions} questions.</p> : null}
              </div>
            </FrameFooter>
          </Frame>

          <div className="flex flex-wrap items-center justify-between gap-3">
            {message ? <p role="alert" className="text-sm text-destructive-foreground">{message}</p> : <span />}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>{isNew ? "Cancel" : "Undo changes"}</Button>
              <Button type="submit" disabled={disabled}>
                {pending ? <Spinner aria-hidden="true" /> : null}
                Save questions
              </Button>
            </div>
          </div>
        </div>

        <aside aria-labelledby="booking-guide-preview-title" className="min-w-0 @3xl:sticky @3xl:top-0">
          <Frame>
            <FrameHeader>
              <FrameTitle id="booking-guide-preview-title">Try it</FrameTitle>
              <FrameDescription>Pick answers to see what {t.customers} would be shown. Nothing here is saved.</FrameDescription>
            </FrameHeader>
            <FramePanel className="flex flex-col gap-5">
              <div className="flex flex-col gap-1">
                <p className="font-heading font-semibold text-base">{draft.title.trim() || "Untitled"}</p>
                {draft.intro.trim() ? <p className="text-sm text-muted-foreground">{draft.intro}</p> : null}
              </div>
              {previewQuestions.length === 0 ? (
                <p className="text-sm text-muted-foreground">Questions you add appear here.</p>
              ) : (
                previewQuestions.map((question) => (
                  <div key={question.id} className="flex flex-col gap-2">
                    <p id={`guide-preview-${question.id}`} className="font-medium text-sm">{question.label}</p>
                    {question.help ? <p className="text-muted-foreground text-xs">{question.help}</p> : null}
                    <GuideQuestionChoices
                      question={question}
                      idPrefix="guide-preview"
                      labelledBy={`guide-preview-${question.id}`}
                      value={answers[question.id] ?? []}
                      onChange={(next) => setAnswers((before) => ({ ...before, [question.id]: next }))}
                    />
                  </div>
                ))
              )}
            </FramePanel>
            <FrameFooter>
              <p role="status" className="text-sm">
                {match.services.length === 0 ? (
                  <span className="text-destructive-foreground">Nothing fits these answers. {t.Customers} are offered the full list instead.</span>
                ) : (
                  <>
                    <span className="font-medium tabular-nums">{match.people.length}</span> of {catalog.practitioners.length} {t.providers} and{" "}
                    <span className="font-medium tabular-nums">{match.services.length}</span> of {catalog.services.length} {t.services} fit.
                  </>
                )}
              </p>
            </FrameFooter>
          </Frame>
        </aside>
      </div>
    </form>
  );
}

interface QuestionEditorProps {
  question: GuideQuestion;
  index: number;
  count: number;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (change: (question: GuideQuestion) => GuideQuestion) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}

function QuestionEditor({ question, index, count, errors, disabled, onChange, onMove, onRemove }: QuestionEditorProps) {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const base = `questions.${index}`;
  const id = `booking-guide-q-${question.id}`;
  const number = index + 1;

  function updateOption(at: number, change: (option: GuideOption) => GuideOption) {
    onChange((before) => ({ ...before, options: before.options.map((option, i) => (i === at ? change(option) : option)) }));
  }

  return (
    <FramePanel className="flex flex-col gap-4" role="group" aria-labelledby={`${id}-heading`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={`${id}-heading`} className="font-medium text-sm">Question {number}</p>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move question ${number} up`} onClick={() => onMove(-1)} disabled={disabled || index === 0}>
            <ArrowUp aria-hidden="true" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move question ${number} down`} onClick={() => onMove(1)} disabled={disabled || index === count - 1}>
            <ArrowDown aria-hidden="true" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove question ${number}`} onClick={onRemove} disabled={disabled}>
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      </div>
      <TextField
        label="Question"
        value={question.label}
        onChange={(event) => onChange((before) => ({ ...before, label: event.target.value }))}
        maxLength={guideLimits.label}
        error={errors[`${base}.label`]}
        disabled={disabled}
      />
      <TextField
        label="Help text"
        optional
        hint="A short hint shown under the question."
        value={question.help ?? ""}
        onChange={(event) => {
          const help = event.target.value;
          onChange((before) => {
            const next: GuideQuestion = { ...before, help };
            if (!help) delete next.help;
            return next;
          });
        }}
        maxLength={guideLimits.help}
        error={errors[`${base}.help`]}
        disabled={disabled}
      />
      <div className="flex flex-col gap-2">
        <p id={`${id}-pick`} className="font-medium text-sm">{t.Customers} can pick</p>
        <RadioGroup
          aria-labelledby={`${id}-pick`}
          value={question.multiple ? "many" : "one"}
          onValueChange={(next) => onChange((before) => ({ ...before, multiple: next === "many" }))}
          disabled={disabled}
          className="flex flex-row flex-wrap gap-x-6 gap-y-2"
        >
          <Label className="flex cursor-pointer items-center gap-2 font-normal">
            <Radio value="one" /> One answer
          </Label>
          <Label className="flex cursor-pointer items-center gap-2 font-normal">
            <Radio value="many" /> Several answers
          </Label>
        </RadioGroup>
      </div>

      <div className="flex flex-col gap-3" role="group" aria-labelledby={`${id}-answers`}>
        <div className="flex flex-col gap-0.5">
          <p id={`${id}-answers`} className="font-medium text-sm">Answers</p>
          <p className="text-muted-foreground text-xs">
            An answer with no {t.services} ticked fits everything, like “I’m not sure”.
          </p>
        </div>
        {question.options.map((option, at) => {
          const optionId = `${id}-a-${option.id}`;
          const optionNumber = at + 1;
          return (
            <div key={option.id} className="flex flex-col gap-3 rounded-lg border p-3" role="group" aria-label={`Answer ${optionNumber} for question ${number}`}>
              <div className="flex items-start gap-2">
                <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
                  <TextField
                    label={`Answer ${optionNumber}`}
                    value={option.label}
                    onChange={(event) => updateOption(at, (before) => ({ ...before, label: event.target.value }))}
                    maxLength={guideLimits.option}
                    error={errors[`${base}.options.${at}.label`]}
                    disabled={disabled}
                  />
                  <TextField
                    label="Short note"
                    optional
                    value={option.description ?? ""}
                    onChange={(event) => {
                      const description = event.target.value;
                      updateOption(at, (before) => {
                        const next: GuideOption = { ...before, description };
                        if (!description) delete next.description;
                        return next;
                      });
                    }}
                    maxLength={guideLimits.optionDescription}
                    error={errors[`${base}.options.${at}.description`]}
                    disabled={disabled}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="mt-7 shrink-0"
                  aria-label={`Remove answer ${optionNumber} from question ${number}`}
                  onClick={() => onChange((before) => ({ ...before, options: before.options.filter((_, i) => i !== at) }))}
                  disabled={disabled || question.options.length <= 2}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
              {catalog.services.length === 0 ? (
                <p className="text-muted-foreground text-xs">Add {t.services} first, then tick the ones this answer fits.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  <p id={`${optionId}-fits`} className="text-muted-foreground text-xs">
                    Fits {option.serviceIds.length === 0 ? `every ${t.service}` : `${option.serviceIds.length} of ${catalog.services.length} ${t.services}`}
                  </p>
                  <CheckboxGroup
                    aria-labelledby={`${optionId}-fits`}
                    value={option.serviceIds}
                    onValueChange={(next) => updateOption(at, (before) => ({ ...before, serviceIds: next }))}
                    disabled={disabled}
                    className="flex-row flex-wrap gap-x-5 gap-y-2"
                  >
                    {catalog.services.map((service) => (
                      <Label key={service.id} className="flex cursor-pointer items-center gap-2 font-normal">
                        <Checkbox value={service.id} />
                        {service.name}
                      </Label>
                    ))}
                  </CheckboxGroup>
                </div>
              )}
            </div>
          );
        })}
        {errors[`${base}.options`] ? <p className="text-xs text-destructive-foreground">{errors[`${base}.options`]}</p> : null}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange((before) => ({ ...before, options: [...before.options, blankOption(before.options)] }))}
            disabled={disabled || question.options.length >= guideLimits.options}
          >
            <Plus aria-hidden="true" /> Add answer
          </Button>
        </div>
      </div>
    </FramePanel>
  );
}
