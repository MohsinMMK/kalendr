/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TestQueryProvider } from "@/test/query-wrapper";

import { json, lookupsMock, session, stubMatchMedia } from "./class-test-fixtures";
import { ClassesWorkspace } from "./classes-workspace";

vi.mock("./clinic-catalog", () => ({ useCatalogLookups: () => lookupsMock() }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount() {
  stubMatchMedia();
  return render(<TestQueryProvider><ClassesWorkspace /></TestQueryProvider>);
}

describe("the classes workspace", () => {
  it("shows a loading state while the week is fetched", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    mount();
    expect(screen.getByRole("status")).toHaveTextContent("Loading the sessions");
  });

  it("says so plainly when the week has no sessions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [] })));
    mount();
    expect(await screen.findByText("No sessions this week")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /New session/ }).length).toBeGreaterThan(0);
  });

  it("shows the error and tries again on request", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: "internal", message: "The server is busy." } }, 500))
      .mockResolvedValue(json({ data: [session()] }));
    vi.stubGlobal("fetch", fetchMock);
    mount();
    expect(await screen.findByText("The server is busy.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Morning yoga")).toBeInTheDocument();
  });

  it("lists sessions by day with seats, the waiting count and a cancelled badge", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [session(), session({ id: "s2", serviceName: "Evening pilates", status: "cancelled", waiting: 0, seatsTaken: 0 })] })));
    mount();
    expect(await screen.findByText("Morning yoga")).toBeInTheDocument();
    expect(screen.getByText("8 of 10 taken")).toBeInTheDocument();
    expect(screen.getByText("3 waiting")).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Seats taken in Morning yoga" })).toBeInTheDocument();
    expect(screen.getAllByText(/10:00 am to 11:00 am/i)).toHaveLength(2);
  });

  it("asks for the next week when the arrow is pressed", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    mount();
    await screen.findByText("No sessions this week");
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
