"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxGroup } from "@/components/ui/checkbox-group";
import { Label } from "@/components/ui/label";
import { RadioGroup } from "@/components/ui/radio-group";
import { RadioCard } from "@/features/booking/radio-card";
import type { GuideOption, GuideQuestion } from "@/lib/booking-guide";
import { cn } from "@/lib/utils";

/** Short answers with nothing to explain sit two to a row, so a long list fits one screen. */
const SHORT_LABEL = 18;
function fitsTwoColumns(options: readonly GuideOption[]) {
  return options.length >= 4 && options.every((option) => !option.description && option.label.length <= SHORT_LABEL);
}

function OptionWords({ option }: { option: GuideOption }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="break-words font-medium text-sm">{option.label}</span>
      {option.description ? <span className="break-words text-muted-foreground text-sm">{option.description}</span> : null}
    </span>
  );
}

/**
 * The answers to one guide question as whole-card choices: radio cards when one answer is allowed,
 * checkbox cards when several are. Used on the customer page and in the owner's preview.
 */
export function GuideQuestionChoices({
  question,
  value,
  onChange,
  labelledBy,
  describedBy,
  idPrefix,
}: {
  question: GuideQuestion;
  /** The chosen answer ids. */
  value: readonly string[];
  onChange: (next: string[]) => void;
  /** The id of the heading that names this question. */
  labelledBy: string;
  describedBy?: string;
  idPrefix: string;
}) {
  const compact = fitsTwoColumns(question.options);
  const layout = compact ? "grid grid-cols-2 items-stretch gap-2" : "gap-2.5";
  const card = compact ? "items-center p-3 sm:p-3 [&>:last-child]:mt-0" : undefined;
  if (question.multiple) {
    return (
      <CheckboxGroup
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        value={[...value]}
        onValueChange={(next) => onChange(next)}
        className={layout}
      >
        {question.options.map((option) => (
          <Label
            key={option.id}
            className={cn(
              "flex w-full min-w-0 cursor-pointer items-start justify-between gap-3 rounded-xl border bg-background p-3.5 font-normal transition-colors hover:bg-accent/50 has-data-checked:border-primary/48 has-data-checked:bg-accent/50 sm:p-4",
              card,
            )}
          >
            <OptionWords option={option} />
            <Checkbox id={`${idPrefix}-${question.id}-${option.id}`} value={option.id} className="mt-0.5" />
          </Label>
        ))}
      </CheckboxGroup>
    );
  }
  return (
    <RadioGroup
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      value={value[0] ?? ""}
      onValueChange={(next) => onChange(typeof next === "string" && next ? [next] : [])}
      className={layout}
    >
      {question.options.map((option) => (
        <RadioCard key={option.id} id={`${idPrefix}-${question.id}-${option.id}`} value={option.id} className={card}>
          <OptionWords option={option} />
        </RadioCard>
      ))}
    </RadioGroup>
  );
}
