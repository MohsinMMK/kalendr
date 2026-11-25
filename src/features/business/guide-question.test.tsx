/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GuideOption, GuideQuestion } from "@/lib/booking-guide";

import { GuideQuestionChoices } from "./guide-question";

afterEach(cleanup);

function question(options: Array<Pick<GuideOption, "label" | "description">>, multiple = false): GuideQuestion {
  return {
    id: "q1",
    label: "What do you need?",
    multiple,
    options: options.map((option, index) => ({ id: `o${index + 1}`, serviceIds: [], ...option })),
  };
}

function renderChoices(value: GuideQuestion, onChange = vi.fn()) {
  render(
    <>
      <h2 id="heading">{value.label}</h2>
      <GuideQuestionChoices question={value} value={[]} onChange={onChange} labelledBy="heading" idPrefix="test" />
    </>,
  );
  return onChange;
}

describe("GuideQuestionChoices", () => {
  it("sets four or more short answers two to a row", () => {
    renderChoices(question([{ label: "Cleaning" }, { label: "Check-up" }, { label: "Whitening" }, { label: "Not sure" }]));
    expect(screen.getByRole("radiogroup", { name: "What do you need?" })).toHaveClass("grid-cols-2");
  });

  it("keeps one answer per row when an answer needs explaining", () => {
    renderChoices(
      question([{ label: "Cleaning" }, { label: "Check-up", description: "A look at how things are going" }, { label: "Whitening" }, { label: "Not sure" }]),
    );
    expect(screen.getByRole("radiogroup", { name: "What do you need?" })).not.toHaveClass("grid-cols-2");
  });

  it("keeps one answer per row for a short list or a long answer", () => {
    renderChoices(question([{ label: "Cleaning" }, { label: "Check-up" }, { label: "Whitening" }]));
    expect(screen.getByRole("radiogroup", { name: "What do you need?" })).not.toHaveClass("grid-cols-2");
    cleanup();
    renderChoices(question([{ label: "Cleaning" }, { label: "Check-up" }, { label: "Whitening" }, { label: "Something else I'd like to talk about" }]));
    expect(screen.getByRole("radiogroup", { name: "What do you need?" })).not.toHaveClass("grid-cols-2");
  });

  it("reports the chosen answers in the two-column layout", async () => {
    const onChange = renderChoices(question([{ label: "Cleaning" }, { label: "Check-up" }, { label: "Whitening" }, { label: "Not sure" }], true));
    expect(screen.getByRole("group", { name: "What do you need?" })).toHaveClass("grid-cols-2");
    await userEvent.click(screen.getByRole("checkbox", { name: "Whitening" }));
    expect(onChange).toHaveBeenCalledWith(["o3"]);
  });
});
