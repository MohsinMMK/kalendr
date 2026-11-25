import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { staffSnapshotFixture as snapshot } from "@/test/staff-fixture";

import { TestQueryProvider } from "@/test/query-wrapper";

import { StaffSnapshotProvider, useStaffSnapshot } from "./staff-snapshot-provider";

function Probe() {
  const { snapshot, loading, error, refresh } = useStaffSnapshot();
  return <><p>{snapshot?.fetchedAt ?? "No snapshot"}</p><p>{loading ? "Loading" : "Ready"}</p><p>{error}</p><button onClick={() => void refresh()}>Refresh</button></>;
}
function Providers({ children }: { children: React.ReactNode }) {
  return <TestQueryProvider><StaffSnapshotProvider role="owner">{children}</StaffSnapshotProvider></TestQueryProvider>;
}
function response(fetchedAt: string): Response {
  return new Response(JSON.stringify({ data: { ...snapshot, fetchedAt } }));
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("staff snapshot refresh", () => {
  it("ignores a stale response even when an aborted transport still completes", async () => {
    const requests: { resolve: (value: Response) => void; signal: AbortSignal }[] = [];
    const fetchMock = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((resolve) => {
      requests.push({ resolve, signal: options.signal as AbortSignal });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<StrictMode><Providers><Probe /></Providers></StrictMode>);
    // Strict mode mounts twice, so the first request may already be abandoned by the time the screen is ready.
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    await act(async () => requests[requests.length - 1].resolve(response("loaded")));
    expect(await screen.findByText("loaded")).toBeInTheDocument();
    // Two refreshes in a row: the first is abandoned for the second.
    const before = requests.length;
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(requests.length).toBe(before + 1));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(requests.length).toBe(before + 2));
    expect(requests[before].signal.aborted).toBe(true);
    await act(async () => requests[before + 1].resolve(response("newest")));
    expect(await screen.findByText("newest")).toBeInTheDocument();
    await act(async () => requests[before].resolve(response("obsolete")));
    expect(screen.getByText("newest")).toBeInTheDocument();
    expect(screen.queryByText("obsolete")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Ready")).toBeInTheDocument());
  });

  it("keeps data on transient failure, but clears it when access is revoked", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response("loaded"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Temporarily unavailable" } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Sign in again" } }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<Providers><Probe /></Providers>);
    expect(await screen.findByText("loaded")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Temporarily unavailable")).toBeInTheDocument();
    expect(screen.getByText("loaded")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Sign in again")).toBeInTheDocument();
    expect(screen.getByText("No snapshot")).toBeInTheDocument();
  });

  it("aborts the pending request when the workspace unmounts", async () => {
    let signal: AbortSignal | null = null;
    vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => {
      signal = options.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    }));
    const view = render(<Providers><Probe /></Providers>);
    await waitFor(() => expect(signal).not.toBeNull());
    view.unmount();
    expect(signal!.aborted).toBe(true);
  });
});
