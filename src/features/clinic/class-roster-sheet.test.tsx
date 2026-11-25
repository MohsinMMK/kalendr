/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TestQueryProvider } from "@/test/query-wrapper";

import { RosterSheet } from "./class-roster-sheet";
import { detail, json, lookupsMock, stubMatchMedia } from "./class-test-fixtures";

vi.mock("./clinic-catalog", () => ({ useCatalogLookups: () => lookupsMock() }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount() {
  stubMatchMedia();
  return render(<TestQueryProvider><RosterSheet sessionId="s1" canManage onClose={() => {}} /></TestQueryProvider>);
}

const calls = (fetchMock: ReturnType<typeof vi.fn>, suffix: string) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));

describe("the roster sheet", () => {
  it("shows people with a seat and the waiting list with the offer time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: detail() })));
    mount();
    expect(await screen.findByText("Bela Nair")).toBeInTheDocument();
    const waiting = screen.getByRole("region", { name: /Waiting list/ });
    expect(within(waiting).getByText("Dev Patel")).toBeInTheDocument();
    expect(within(waiting).getByText(/Offer holds until 9:00 am/i)).toBeInTheDocument();
  });

  it("marks someone present with their own version and shows what the server sends back", async () => {
    const user = userEvent.setup();
    const after = detail({ roster: detail().roster.map((entry) => (entry.enrolmentId === "e1" ? { ...entry, status: "attended" as const, version: 3 } : entry)) });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => (init?.method === "POST" && String(url).endsWith("/attendance") ? json({ data: after }) : json({ data: detail() })));
    vi.stubGlobal("fetch", fetchMock);
    mount();
    await user.click(await screen.findByRole("button", { name: "Present: Bela Nair" }));
    await waitFor(() => expect(calls(fetchMock, "/attendance")).toHaveLength(1));
    expect(JSON.parse(String((calls(fetchMock, "/attendance")[0]![1] as RequestInit).body))).toEqual({ enrolmentId: "e1", expectedVersion: 2, outcome: "attended" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Present: Bela Nair" })).toHaveAttribute("aria-pressed", "true"));
  });

  it("reloads the roster when someone else changed it first", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => (init?.method === "POST"
      ? json({ error: { code: "version_conflict", message: "Changed by someone else." } }, 409)
      : json({ data: detail() })));
    vi.stubGlobal("fetch", fetchMock);
    mount();
    await user.click(await screen.findByRole("button", { name: "Absent: Bela Nair" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) => !(init as RequestInit | undefined)?.method && String(url).endsWith("/api/staff/classes/s1"))).toHaveLength(2));
  });

  it("explains that the session is full when a walk-in is refused", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => (init?.method === "POST" && String(url).endsWith("/walk-in")
      ? json({ error: { code: "class_full", message: "No seats left." } }, 409)
      : json({ data: detail() })));
    vi.stubGlobal("fetch", fetchMock);
    mount();
    await user.click(await screen.findByRole("button", { name: /Add walk-in/ }));
    await user.type(await screen.findByLabelText("First name"), "Esha");
    await user.type(screen.getByLabelText("Last name"), "Iyer");
    await user.click(screen.getByRole("button", { name: "Add walk-in", description: undefined }));
    expect(await screen.findByText(/This session is full/)).toBeInTheDocument();
    expect(JSON.parse(String((calls(fetchMock, "/walk-in")[0]![1] as RequestInit).body))).toEqual({ firstName: "Esha", lastName: "Iyer" });
  });
});
