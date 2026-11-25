/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RatingPageState } from "@/lib/rating-page";

import { RatingPage } from "./rating-page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open: RatingPageState = { business: "Cedar Hair", service: "Haircut", phase: "open", review: null, editableUntil: null };

function stubApi() {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { rating?: number; comment?: string; visibility?: "public" | "private" };
    const rating = body.rating ?? 4;
    const state: RatingPageState = {
      ...open, phase: "answered", editableUntil: "2026-12-01T00:00:00.000Z",
      review: { rating, comment: body.comment ?? null, visibility: body.visibility ?? (rating <= 2 ? "private" : "public") },
    };
    return { ok: true, status: 200, json: async () => ({ data: state }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("RatingPage", () => {
  it("records the stars with one tap and then offers a comment", async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi();
    render(<RatingPage token={"t".repeat(43)} initial={open} />);
    expect(screen.getByText("How was Haircut?")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "4 stars" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ rating: 4 });
    expect(await screen.findByText("Thanks, you rated 4 stars")).toBeInTheDocument();
    expect(screen.getByLabelText("Show on the business page")).toBeChecked();
  });

  it("starts a low score as private and sends the choice with the comment", async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi();
    render(<RatingPage token={"t".repeat(43)} initial={open} />);
    await user.click(screen.getByRole("radio", { name: "1 star" }));
    expect(await screen.findByLabelText("Only for the business")).toBeChecked();
    await user.type(screen.getByRole("textbox"), "Too long a wait");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({ rating: 1, comment: "Too long a wait", visibility: "private" });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("shows only the answer once the week to change it has passed", () => {
    render(<RatingPage token={"t".repeat(43)} initial={{ ...open, phase: "closed", review: { rating: 5, comment: "Great", visibility: "public" } }} />);
    expect(screen.getByText("Thanks, you rated 5 stars")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByText("Great")).toBeInTheDocument();
  });

  it("says when the link has run out", () => {
    render(<RatingPage token={"t".repeat(43)} initial={{ ...open, phase: "expired" }} />);
    expect(screen.getByText("This link has run out")).toBeInTheDocument();
  });
});
