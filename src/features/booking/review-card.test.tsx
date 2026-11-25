/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReviewState } from "@/lib/reviews";

import { ReviewCard } from "./review-card";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function stubReviewApi(initial: ReviewState) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { rating: number; comment?: string };
      return jsonResponse({ data: { ...initial, review: { rating: body.rating, comment: body.comment ?? null } } });
    }
    return jsonResponse({ data: initial });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ReviewCard", () => {
  it("shows nothing while the visit can't be reviewed", async () => {
    const fetchMock = stubReviewApi({ open: false, closesAt: null, review: null });
    const { container } = render(<ReviewCard manageToken="token_12345" />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("sends a star rating and comment, then shows the saved review with Edit", async () => {
    const user = userEvent.setup();
    const fetchMock = stubReviewApi({ open: true, closesAt: "2027-01-10T00:00:00.000Z", review: null });
    render(<ReviewCard manageToken="token_12345" personName="Dr Meera Iyer" />);

    expect(await screen.findByText("How was your appointment?")).toBeInTheDocument();
    expect(screen.getByText("Please don't include health details.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send review" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a star rating first.");

    await user.click(screen.getByRole("radio", { name: "4 stars" }));
    expect(screen.getByText("Very good")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "Kind and quick.");
    await user.click(screen.getByRole("button", { name: "Send review" }));

    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(put?.[0]).toBe("/api/public/appointments/token_12345/review");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ rating: 4, comment: "Kind and quick." });

    expect(await screen.findByText("Your review")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "4 out of 5 stars" })).toBeInTheDocument();
    expect(screen.getByText("Kind and quick.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit review" })).toBeInTheDocument();
  });
});
