import type { FormAnswer } from "@/lib/booking-forms";

/**
 * A booking question as a placeholder (feature 50): named by its link name, or its id when it has none, in lower case.
 * Answers become one line of text each; a name or an address is joined, a tick box is Yes or No, a list is joined with commas.
 */
export function questionKey(field: { id: string; prefillKey?: string | undefined }): string {
  return (field.prefillKey || field.id).toLowerCase();
}

function text(answer: FormAnswer | undefined): string {
  if (answer === undefined || answer === null) return "";
  if (typeof answer === "string") return answer;
  if (typeof answer === "boolean") return answer ? "Yes" : "No";
  if (Array.isArray(answer)) return answer.join(", ");
  if ("first" in answer) return `${answer.first} ${answer.last}`.trim();
  return [answer.line1, answer.line2, answer.city, answer.state, answer.pin].filter(Boolean).join(", ");
}

export function answerValues(fields: readonly { id: string; prefillKey?: string | undefined; hidden?: boolean | undefined }[], answers: Record<string, FormAnswer>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const value = text(answers[field.id]).replace(/\s+/g, " ").trim();
    if (value) values[questionKey(field)] = value;
  }
  return values;
}
