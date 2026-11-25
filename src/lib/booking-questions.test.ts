import { describe, expect, it } from "vitest";

import { checkFormAnswers, formDefinitionDraftSchema, isFieldVisible, readPrefill, type FormField } from "./booking-forms";

const visited: FormField = { id: "visited", type: "yes_no", label: "Have you visited before?", required: true };
const heard: FormField = { id: "heard", type: "short_text", label: "How did you hear about us?", required: true, showWhen: [{ fieldId: "visited", operator: "equals", value: "no" }] };

describe("conditions", () => {
  // yes_no answers are booleans; the condition compares them as the words yes and no.
  it("reveals a question on one answer and hides it on another", () => {
    expect(isFieldVisible(heard, { visited: false }, [visited, heard])).toBe(true);
    expect(isFieldVisible(heard, { visited: true }, [visited, heard])).toBe(false);
    expect(isFieldVisible(heard, {}, [visited, heard])).toBe(false);
  });

  it("requires a revealed question and does not require a hidden one", () => {
    expect(checkFormAnswers([visited, heard], { visited: false })).toMatchObject({ ok: false, errors: { heard: expect.any(String) } });
    expect(checkFormAnswers([visited, heard], { visited: true })).toEqual({ ok: true, answers: { visited: true } });
  });

  it("drops an answer sent for a question the customer was never shown", () => {
    expect(checkFormAnswers([visited, heard], { visited: true, heard: "a crafted answer" })).toEqual({ ok: true, answers: { visited: true } });
  });

  it("supports not equals, contains and one of", () => {
    const pick: FormField = { id: "pick", type: "multi_select", label: "Pick", required: false, options: ["a", "b", "c"] };
    const when = (operator: "not_equals" | "contains" | "one_of", value: string | string[]): FormField => ({ id: "x", type: "short_text", label: "X", required: false, showWhen: [{ fieldId: "pick", operator, value }] });
    expect(isFieldVisible(when("contains", "b"), { pick: ["a", "b"] }, [pick, when("contains", "b")])).toBe(true);
    expect(isFieldVisible(when("contains", "c"), { pick: ["a", "b"] }, [pick, when("contains", "c")])).toBe(false);
    expect(isFieldVisible(when("one_of", ["c", "a"]), { pick: ["a"] }, [pick, when("one_of", ["c", "a"])])).toBe(true);
    expect(isFieldVisible(when("not_equals", "a"), { pick: ["a"] }, [pick, when("not_equals", "a")])).toBe(false);
  });

  it("hides a question that depends on one that is itself hidden", () => {
    const third: FormField = { id: "third", type: "short_text", label: "Third", required: true, showWhen: [{ fieldId: "heard", operator: "equals", value: "friend" }] };
    expect(checkFormAnswers([visited, heard, third], { visited: true, heard: "friend", third: "x" })).toEqual({ ok: true, answers: { visited: true } });
  });

  it("only lets a question depend on an earlier one", () => {
    const draft = (fields: unknown[]) => formDefinitionDraftSchema.safeParse({ name: "F", fields, appliesToAll: true });
    const later = { id: "a", type: "short_text", label: "A", required: false, showWhen: [{ fieldId: "b", operator: "equals", value: "x" }] };
    const earlier = { id: "b", type: "short_text", label: "B", required: false };
    expect(draft([later, earlier]).success).toBe(false);
    expect(draft([earlier, { ...later, id: "c" }]).success).toBe(true);
  });
});

describe("required per service", () => {
  it("lets one form be required on one service and optional on another", () => {
    const optionalHere: FormField = { id: "referral", type: "url", label: "Referral letter link", required: false };
    expect(checkFormAnswers([optionalHere], {}, { requiredOverrides: { referral: true } })).toMatchObject({ ok: false });
    expect(checkFormAnswers([optionalHere], {})).toEqual({ ok: true, answers: {} });
    const requiredHere: FormField = { ...optionalHere, required: true };
    expect(checkFormAnswers([requiredHere], {}, { requiredOverrides: { referral: false } })).toEqual({ ok: true, answers: {} });
  });
});

describe("new question types", () => {
  it("checks web addresses, guests, split names and addresses", () => {
    const fields: FormField[] = [
      { id: "site", type: "url", label: "Site", required: true },
      { id: "guests", type: "emails", label: "Guests", required: false },
      { id: "who", type: "name_split", label: "Name", required: true },
      { id: "home", type: "address", label: "Home", required: true },
    ];
    const good = { site: "https://example.com/x", guests: ["a@example.com", "b@example.com"], who: { first: "Asha", last: "Rao" }, home: { line1: "12 Park Road", city: "Pune", state: "MH", pin: "411001" } };
    expect(checkFormAnswers(fields, good)).toEqual({ ok: true, answers: good });
    expect(checkFormAnswers(fields, { ...good, site: "javascript:alert(1)" })).toMatchObject({ ok: false, errors: { site: expect.any(String) } });
    expect(checkFormAnswers(fields, { ...good, guests: ["a@example.com", "A@example.com"] })).toMatchObject({ ok: false, errors: { guests: expect.any(String) } });
    expect(checkFormAnswers(fields, { ...good, who: { first: "Asha", last: "" } })).toMatchObject({ ok: false, errors: { who: expect.any(String) } });
    expect(checkFormAnswers(fields, { ...good, home: { line1: "12 Park Road", city: "", state: "MH", pin: "411001" } })).toMatchObject({ ok: false, errors: { home: expect.any(String) } });
  });

  it("keeps radio, checkbox group and multi select to their options", () => {
    const fields: FormField[] = [
      { id: "r", type: "radio", label: "R", required: true, options: ["one", "two"] },
      { id: "c", type: "checkbox_group", label: "C", required: false, options: ["x", "y"] },
    ];
    expect(checkFormAnswers(fields, { r: "one", c: ["x"] })).toEqual({ ok: true, answers: { r: "one", c: ["x"] } });
    expect(checkFormAnswers(fields, { r: "three" })).toMatchObject({ ok: false });
    expect(formDefinitionDraftSchema.safeParse({ name: "F", fields: [{ id: "r", type: "radio", label: "R", required: false, options: ["only"] }] }).success).toBe(false);
  });
});

describe("prefill from the link", () => {
  const fields: FormField[] = [
    { id: "campaign", type: "short_text", label: "Campaign", required: false, hidden: true, prefillKey: "campaign" },
    { id: "plan", type: "single_choice", label: "Plan", required: false, options: ["basic", "plus"], prefillKey: "plan", lockWhenPrefilled: true },
  ];

  it("fills a hidden question and locks a visible one, ignoring values that do not fit", () => {
    expect(readPrefill(fields, new URLSearchParams("campaign=diwali&plan=plus"))).toEqual({ answers: { campaign: "diwali", plan: "plus" }, locked: ["plan"] });
    expect(readPrefill(fields, new URLSearchParams("plan=gold"))).toEqual({ answers: {}, locked: [] });
  });

  it("stores a valid hidden answer and drops an invalid one", () => {
    expect(checkFormAnswers(fields, { campaign: "diwali" })).toEqual({ ok: true, answers: { campaign: "diwali" } });
    expect(checkFormAnswers([{ ...fields[0]!, type: "number" }], { campaign: "not a number" })).toEqual({ ok: true, answers: {} });
  });

  it("will not let a question take a link name the booking page already uses, and a hidden one needs a name", () => {
    const parse = (field: object) => formDefinitionDraftSchema.safeParse({ name: "F", fields: [{ id: "q", type: "short_text", label: "Q", required: false, ...field }] }).success;
    expect(parse({ prefillKey: "email" })).toBe(false);
    expect(parse({ hidden: true })).toBe(false);
    expect(parse({ hidden: true, prefillKey: "campaign" })).toBe(true);
  });
});
