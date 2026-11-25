/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FormAnswer, FormField } from "@/lib/booking-forms";

import { BookingFormQuestion } from "./booking-form-question";

afterEach(cleanup);

function Harness({ field, onAnswer, initial }: { field: FormField; onAnswer: (value: FormAnswer | undefined) => void; initial?: FormAnswer }) {
  const [value, setValue] = useState<FormAnswer | undefined>(initial);
  return <BookingFormQuestion field={field} value={value} onChange={(next) => { setValue(next); onAnswer(next); }} />;
}

const optionalText: FormField = { id: "notes", type: "short_text", label: "Anything we should know about?", required: false };

describe("choice questions", () => {
  it("renders yes/no as tappable buttons and stores a boolean", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<Harness field={{ id: "first", type: "yes_no", label: "Is this your first time?", required: true }} onAnswer={onAnswer} />);
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Yes" }));
    expect(onAnswer).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("button", { name: "Yes" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "No" }));
    expect(onAnswer).toHaveBeenLastCalledWith(false);
  });

  it("stores one option for a single choice and clears it on a second tap", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<Harness field={{ id: "level", type: "single_choice", label: "Level", required: false, options: ["Beginner", "Advanced"] }} onAnswer={onAnswer} />);
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    expect(onAnswer).toHaveBeenLastCalledWith("Advanced");
    await user.click(screen.getByRole("button", { name: "Beginner" }));
    expect(onAnswer).toHaveBeenLastCalledWith("Beginner");
    await user.click(screen.getByRole("button", { name: "Beginner" }));
    expect(onAnswer).toHaveBeenLastCalledWith(undefined);
  });

  it("stores several options in the business's order for a multiple choice", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<Harness field={{ id: "t", type: "multiple_choice", label: "Topics", required: false, options: ["Teeth", "Gums", "Braces"] }} onAnswer={onAnswer} />);
    await user.click(screen.getByRole("button", { name: "Braces" }));
    await user.click(screen.getByRole("button", { name: "Teeth" }));
    expect(onAnswer).toHaveBeenLastCalledWith(["Teeth", "Braces"]);
  });
});

describe("optional free text", () => {
  it("starts collapsed as No / Yes with no answer and no box", () => {
    const onAnswer = vi.fn();
    render(<Harness field={optionalText} onAnswer={onAnswer} />);
    expect(screen.getByRole("button", { name: "No" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Yes" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("opens the box on Yes and drops the answer again on No", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<Harness field={optionalText} onAnswer={onAnswer} />);
    await user.click(screen.getByRole("button", { name: "Yes" }));
    await user.type(screen.getByRole("textbox", { name: "Anything we should know about?" }), "Sensitive skin");
    expect(onAnswer).toHaveBeenLastCalledWith("Sensitive skin");
    await user.click(screen.getByRole("button", { name: "No" }));
    expect(onAnswer).toHaveBeenLastCalledWith(undefined);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("opens straight away when there is already an answer", () => {
    render(<Harness field={optionalText} onAnswer={vi.fn()} initial="Nuts" />);
    expect(screen.getByRole("textbox", { name: "Anything we should know about?" })).toHaveValue("Nuts");
  });

  it("keeps a required free-text question as a plain box", () => {
    render(<BookingFormQuestion field={{ ...optionalText, required: true }} value={undefined} onChange={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: /Anything we should know about\?/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yes" })).not.toBeInTheDocument();
  });
});
