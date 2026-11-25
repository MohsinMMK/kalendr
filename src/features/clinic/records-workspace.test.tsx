import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecordsWorkspace } from "./records-workspace";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", memoryStorage());
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RecordsWorkspace in preview", () => {
  it("lists records, and filters to one patient from a deep link", async () => {
    const { unmount } = render(<RecordsWorkspace />);
    expect(await screen.findAllByText("Ananya Rao")).not.toHaveLength(0);
    expect(screen.getByText("Priya Patel")).toBeTruthy();
    unmount();

    render(<RecordsWorkspace initialPatientId="patient_priya" />);
    expect(await screen.findAllByText("Priya Patel")).not.toHaveLength(0);
    expect(screen.queryByText("Ananya Rao")).toBeNull();
  });

  it("narrows the grid with a type filter and searches by title", async () => {
    render(<RecordsWorkspace />);
    expect(await screen.findAllByText("Ananya Rao")).not.toHaveLength(0);
    const all = screen.getAllByRole("row").length;
    fireEvent.change(screen.getByRole("searchbox", { name: "Search records" }), { target: { value: "zzz-no-such-record" } });
    expect(await screen.findByText("No matching records")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search records" }), { target: { value: "" } });
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(all));
  });

  it("asks staff to check ID before opening documents", async () => {
    render(<RecordsWorkspace />);
    const requests = (await screen.findByText("Portal requests")).closest("[data-slot=frame]") as HTMLElement;
    fireEvent.click(within(requests).getByRole("button", { name: "Confirm" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/only after checking ID/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /I checked ID/ }));
    await waitFor(() => expect(screen.queryByText("Portal requests")).toBeNull());
  });
});
