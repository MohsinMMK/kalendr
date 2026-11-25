"use client";

import { isFieldVisible, type FormAnswer, type FormAnswers, type PublicFormDefinition } from "@/lib/booking-forms";

import { isRequired, shownQuestions } from "../booking-answers";
import { BookingFormQuestion } from "../booking-form-question";
import { StepHeader } from "./step-header";

/**
 * The business's own questions for the chosen service, titled with the form's name. A question shows only while
 * its conditions hold, so answering one can reveal or hide others as the customer goes.
 */
export function QuestionsStep({
  form,
  serviceId,
  answers,
  locked,
  allowGuests,
  errors,
  onAnswer,
  declined = [],
  onDeclinedChange,
}: {
  form: PublicFormDefinition;
  serviceId: string;
  /** What the customer has answered, with the values the link filled in. */
  answers: FormAnswers;
  /** Questions the link filled in and keeps read-only. */
  locked: readonly string[];
  /** Guests are added in the details step, so a guest-email question is not asked here. */
  allowGuests: boolean;
  errors: Record<string, string>;
  onAnswer: (questionId: string, value: FormAnswer | undefined) => void;
  /** Optional text questions the customer said No to. Kept on the client so Back and Forward remember it; never sent. */
  declined?: readonly string[];
  onDeclinedChange?: (questionId: string, declined: boolean) => void;
}) {
  const shown = shownQuestions(form, allowGuests).filter((field) => isFieldVisible(field, answers, form.fields));
  return (
    <div className="flex flex-col gap-5">
      <StepHeader title={form.name} description={form.description || undefined} />
      <div className="flex flex-col gap-5">
        {shown.map((field) => (
          <BookingFormQuestion
            key={field.id}
            field={field}
            value={answers[field.id]}
            required={isRequired(field, form, serviceId, allowGuests)}
            locked={locked.includes(field.id)}
            error={errors[`formAnswers.${field.id}`]}
            onChange={(value) => onAnswer(field.id, value)}
            declined={declined.includes(field.id)}
            onDeclinedChange={(isDeclined) => onDeclinedChange?.(field.id, isDeclined)}
          />
        ))}
      </div>
    </div>
  );
}
