/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TeamShareView } from "@/lib/routing-contracts";
import { TestQueryProvider } from "@/test/query-wrapper";

import { TeamShareCard, recentMonths } from "./team-share-card";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const month = recentMonths()[0]!.value;
const share = (people: TeamShareView["people"]): TeamShareView => ({ month, total: people.reduce((sum, person) => sum + person.bookings, 0), people });
const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

function setup(answer: () => Response) {
  const fetchMock = vi.fn(async () => answer());
  vi.stubGlobal("fetch", fetchMock);
  render(<TestQueryProvider><TeamShareCard /></TestQueryProvider>);
  return fetchMock;
}

describe("team share card", () => {
  it("lists six months, newest first", () => {
    const months = recentMonths(new Date(2026, 0, 15));
    expect(months).toHaveLength(6);
    expect(months.map((entry) => entry.value)).toEqual(["2026-01", "2025-12", "2025-11", "2025-10", "2025-09", "2025-08"]);
  });

  it("loads the current month, showing a skeleton first", async () => {
    const fetchMock = setup(() => json(share([{ practitionerId: "p1", name: "Asha", bookings: 6, sharePercent: 60, weightPercent: 40 }, { practitionerId: "p2", name: "Ben", bookings: 4, sharePercent: 40, weightPercent: 60 }])));
    expect(screen.getByRole("status", { name: "Loading share of bookings" })).toBeInTheDocument();
    expect(await screen.findByText("Asha")).toBeInTheDocument();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`/api/staff/routing/share?month=${month}`);
    expect(screen.getByRole("img", { name: "Asha: 60% of bookings, meant to take 40%" })).toBeInTheDocument();
    expect(screen.getByText("Meant to take 60%")).toBeInTheDocument();
    expect(screen.getByText("10 bookings in total.")).toBeInTheDocument();
  });

  it("says when there are no bookings", async () => {
    setup(() => json(share([])));
    expect(await screen.findByText("No bookings yet this month.")).toBeInTheDocument();
  });

  it("shows the error and retries", async () => {
    const user = userEvent.setup();
    let calls = 0;
    setup(() => (++calls === 1 ? new Response(JSON.stringify({ error: { code: "error", message: "Share failed." } }), { status: 500 }) : json(share([{ practitionerId: "p1", name: "Asha", bookings: 1, sharePercent: 100, weightPercent: 100 }]))));
    expect(await screen.findByText("Share failed.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Asha")).toBeInTheDocument();
  });
});
