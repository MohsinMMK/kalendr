import { describe, expect, it } from "vitest";

import { businessTypeIds, isClinicalBusinessType } from "./business-types";
import {
  checkFormAnswers,
  formAnswersSchema,
  formDefinitionDraftSchema,
  formForService,
  formatFormAnswer,
  newFieldId,
  starterForms,
  type FormField,
} from "./booking-forms";

const fields: FormField[] = [
  { id: "goal", type: "short_text", label: "What would you like done?", required: true },
  { id: "notes", type: "long_text", label: "Anything else?", required: false },
  { id: "email", type: "email", label: "Work email", required: false },
  { id: "phone", type: "phone", label: "Other phone", required: false },
  { id: "guests", type: "number", label: "Guests", required: false },
  { id: "when", type: "date", label: "Move date", required: false },
  { id: "size", type: "single_choice", label: "Size", required: true, options: ["Small", "Large"] },
  { id: "extras", type: "multiple_choice", label: "Extras", required: false, options: ["Wash", "Dry", "Style"] },
  { id: "first", type: "yes_no", label: "First time?", required: true },
  { id: "agree", type: "consent", label: "I agree", required: true },
];

const goodAnswers = { goal: "  Trim  ", size: "Large", extras: ["Wash", "Style"], first: false, agree: true, notes: "" };

describe("form definitions", () => {
  it("accepts a valid form and forces consent boxes to be required", () => {
    const draft = formDefinitionDraftSchema.parse({
      name: " Intake ",
      fields: [{ id: "agree", type: "consent", label: "I agree", required: false }],
    });
    expect(draft).toMatchObject({ name: "Intake", description: "", isActive: true, appliesToAll: true, serviceIds: [] });
    expect(draft.fields[0]?.required).toBe(true);
  });

  it("refuses an empty form, a blank label, duplicate ids and too many questions", () => {
    expect(formDefinitionDraftSchema.safeParse({ name: "Form", fields: [] }).success).toBe(false);
    expect(formDefinitionDraftSchema.safeParse({ name: "Form", fields: [{ id: "a", type: "short_text", label: " ", required: false }] }).success).toBe(false);
    expect(formDefinitionDraftSchema.safeParse({
      name: "Form",
      fields: [
        { id: "a", type: "short_text", label: "One", required: false },
        { id: "a", type: "short_text", label: "Two", required: false },
      ],
    }).success).toBe(false);
    const many = Array.from({ length: 41 }, (_, index) => ({ id: `q${index}`, type: "short_text", label: `Q${index}`, required: false }));
    expect(formDefinitionDraftSchema.safeParse({ name: "Form", fields: many }).success).toBe(false);
  });

  it("needs two different options for choice questions and none for others", () => {
    const one = { id: "c", type: "single_choice", label: "Pick", required: false, options: ["Only"] };
    const twice = { ...one, options: ["Same", "same"] };
    const textWithOptions = { id: "t", type: "short_text", label: "Text", required: false, options: ["A", "B"] };
    for (const field of [one, twice, textWithOptions]) {
      expect(formDefinitionDraftSchema.safeParse({ name: "Form", fields: [field] }).success).toBe(false);
    }
  });

  it("needs a service when the form is not for every service, and drops services when it is", () => {
    const field = { id: "a", type: "short_text", label: "One", required: false };
    expect(formDefinitionDraftSchema.safeParse({ name: "Form", fields: [field], appliesToAll: false, serviceIds: [] }).success).toBe(false);
    expect(formDefinitionDraftSchema.parse({ name: "Form", fields: [field], appliesToAll: true, serviceIds: ["s1"] }).serviceIds).toEqual([]);
    expect(formDefinitionDraftSchema.parse({ name: "Form", fields: [field], appliesToAll: false, serviceIds: ["s1", "s1"] }).serviceIds).toEqual(["s1"]);
  });

  it.each(businessTypeIds)("has a valid starter form for %s", (id) => {
    const parsed = formDefinitionDraftSchema.safeParse(starterForms[id]);
    expect(parsed.success).toBe(true);
  });

  it.each(businessTypeIds.filter((id) => !isClinicalBusinessType(id)))("keeps clinical words out of the %s starter form", (id) => {
    const form = starterForms[id];
    const words = [form.name, form.description, ...form.fields.flatMap((field) => [field.label, field.help ?? "", ...(field.options ?? [])])];
    for (const word of words) expect(word).not.toMatch(/\b(patients?|doctors?|clinics?|medical|medicines?|medications?|dental|dentist)\b/i);
  });

  it("makes new question ids that are not taken", () => {
    expect(newFieldId([])).toBe("q1");
    expect(newFieldId([{ id: "q2" }, { id: "x" }])).toBe("q3");
    expect(newFieldId([{ id: "q2" }])).toBe("q3");
  });
});

describe("form answers", () => {
  it("accepts good answers, trims text and drops blank optional answers", () => {
    const result = checkFormAnswers(fields, goodAnswers);
    expect(result).toEqual({ ok: true, answers: { goal: "Trim", size: "Large", extras: ["Wash", "Style"], first: false, agree: true } });
  });

  it("explains every problem by question", () => {
    const result = checkFormAnswers(fields, {
      goal: "",
      email: "not-an-email",
      phone: "call me",
      guests: "two",
      when: "2026-02-30",
      size: "Medium",
      extras: ["Wash", "Wash"],
      agree: false,
      stranger: "hello",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(["agree", "email", "extras", "first", "goal", "guests", "phone", "size", "stranger", "when"]);
    expect(result.errors.agree).toBe("Tick this box to continue.");
    expect(result.errors.first).toBe("Choose yes or no.");
  });

  it("refuses an answer of the wrong kind", () => {
    const result = checkFormAnswers(fields, { ...goodAnswers, goal: ["Trim"], first: "no" });
    expect(result.ok).toBe(false);
  });

  it("limits the shape of answers sent with a booking", () => {
    expect(formAnswersSchema.safeParse({ goal: "Trim", extras: ["Wash"], agree: true }).success).toBe(true);
    expect(formAnswersSchema.safeParse({ goal: { nested: true } }).success).toBe(false);
    expect(formAnswersSchema.safeParse({ "bad key!": "x" }).success).toBe(false);
    expect(formAnswersSchema.safeParse({ goal: "x".repeat(3001) }).success).toBe(false);
  });

  it("shows answers in plain words", () => {
    expect(formatFormAnswer(fields[8]!, true)).toBe("Yes");
    expect(formatFormAnswer(fields[9]!, true)).toBe("Agreed");
    expect(formatFormAnswer(fields[7]!, ["Wash", "Dry"])).toBe("Wash, Dry");
    expect(formatFormAnswer(fields[1]!, undefined)).toBe("No answer");
  });
});

describe("choosing the form for a service", () => {
  const all = { id: "all", appliesToAll: true, serviceIds: [] };
  const colour = { id: "colour", appliesToAll: false, serviceIds: ["service_colour"] };

  it("prefers a form chosen for the service over one for every service", () => {
    expect(formForService([all, colour], "service_colour")?.id).toBe("colour");
    expect(formForService([all, colour], "service_cut")?.id).toBe("all");
    expect(formForService([colour], "service_cut")).toBeUndefined();
    expect(formForService([all], undefined)).toBeUndefined();
  });
});
