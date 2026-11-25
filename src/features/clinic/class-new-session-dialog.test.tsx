/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QueryClient } from "@tanstack/react-query";

import { TestQueryProvider } from "@/test/query-wrapper";
import { StaffQueryProvider } from "./queries/client";

import { NewSessionDialog } from "./class-new-session-dialog";
import { classKeys } from "./class-model";
import { json, lookupsMock } from "./class-test-fixtures";

vi.mock("./clinic-catalog", () => ({ useCatalogLookups: () => lookupsMock() }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const classes = [{ serviceId: "svc1", name: "Morning yoga", durationMinutes: 60, capacity: 10, locationIds: ["l1"], practitionerIds: ["p1"], priceMinor: null }];

describe("the new session dialog", () => {
  it("lists each clash with its reason and creates nothing", async () => {
    const user = userEvent.setup();
    const clashes = [{ date: "2026-12-01", reason: "Asha Rao already teaches at that time." }, { date: "2026-12-08", reason: "The studio is closed that day." }];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "POST"
      ? json({ data: { created: 0, sessionIds: [], seriesId: null, clashes } }, 409)
      : json({ data: classes })));
    vi.stubGlobal("fetch", fetchMock);
    const onCreated = vi.fn();
    render(<TestQueryProvider><NewSessionDialog onClose={() => {}} onCreated={onCreated} /></TestQueryProvider>);
    await user.click(await screen.findByRole("combobox", { name: /Class/ }));
    await user.click(await screen.findByRole("option", { name: "Morning yoga" }));
    await user.click(screen.getByRole("button", { name: "Add session" }));
    const list = await screen.findByRole("list", { name: "Dates that clash" });
    expect(within(list).getByText(/Asha Rao already teaches at that time/)).toBeInTheDocument();
    expect(within(list).getByText(/The studio is closed that day/)).toBeInTheDocument();
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(onCreated).not.toHaveBeenCalled();
    const body = JSON.parse(String((fetchMock.mock.calls.find(([, init]) => init?.method === "POST")![1] as RequestInit).body));
    expect(body).toMatchObject({ serviceId: "svc1", practitionerId: "p1", locationId: "l1", time: "09:00", capacity: 10 });
  });
  it("offers to add a class when there are none yet", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [] })));
    const onAddClass = vi.fn();
    render(<TestQueryProvider><NewSessionDialog onClose={() => {}} onCreated={() => {}} onAddClass={onAddClass} /></TestQueryProvider>);
    expect(await screen.findByText(/You have no classes yet/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add a class" }));
    expect(onAddClass).toHaveBeenCalledOnce();
  });

  it("starts on the class just added, even when the cached list does not have it yet", async () => {
    const added = { ...classes[0]!, serviceId: "svc2", name: "Evening pilates", practitionerIds: ["p1"] };
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [...classes, added] })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: Infinity } } });
    // The list cached before the class was added, already marked stale, as New class leaves it.
    client.setQueryData(classKeys.types, classes);
    await client.invalidateQueries({ queryKey: classKeys.types });
    render(<StaffQueryProvider scope="test" client={client}><NewSessionDialog initialServiceId="svc2" onClose={() => {}} onCreated={() => {}} /></StaffQueryProvider>);
    const field = await screen.findByRole("combobox", { name: /Class/ });
    await waitFor(() => expect(field).toHaveTextContent("Evening pilates"));
  });
});
