/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivityLog } from "./activity-log";

vi.mock("./clinic-catalog", () => ({ useCatalogLookups: () => ({ database: true }) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ActivityLog", () => {
  it("shows Kalendr support sessions as one plain sentence with their own badge", async () => {
    const entries = [
      { id: "1", occurredAt: "2026-11-19T08:00:00.000Z", actor: "Kalendr support", outcome: "success", summary: "Kalendr support started a session (read-only)", changes: [], appointmentId: null, support: true },
      { id: "2", occurredAt: "2026-11-19T07:00:00.000Z", actor: "Asha Rao", outcome: "success", summary: "Changed a role", changes: [], appointmentId: null },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { entries, nextCursor: null } }) }) as Response));
    render(<ActivityLog />);
    const sentence = await screen.findByText("Kalendr support started a session (read-only)");
    expect(sentence.textContent).not.toMatch(/Kalendr support Kalendr support/i);
    expect(screen.getByText("Kalendr support")).toBeInTheDocument();
    expect(screen.getByText("changed a role")).toBeInTheDocument();
  });
});
