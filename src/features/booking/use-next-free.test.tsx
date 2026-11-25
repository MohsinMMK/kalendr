/** @vitest-environment jsdom */

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useNextFree } from "./use-next-free";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const base = { enabled: true, clinicSlug: "c", locationId: "l1", serviceId: "s1" };

describe("useNextFree", () => {
  it("asks for the pooled list over 14 days and returns each person's next time and the earliest", async () => {
    const fetchMock = vi.fn(async () => json({ data: { slots: [], nextByPerson: { a: "2030-01-02T10:00:00.000Z", b: "2030-01-01T09:00:00.000Z" } } }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useNextFree({ ...base, durationMinutes: 30 }));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.earliest).toBe("2030-01-01T09:00:00.000Z");
    expect(result.current.nextByPerson.a).toBe("2030-01-02T10:00:00.000Z");
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]), "http://x");
    expect(url.searchParams.get("practitionerId")).toBe("anyone");
    expect(url.searchParams.get("durationMinutes")).toBe("30");
    const span = Date.parse(url.searchParams.get("to")!) - Date.parse(url.searchParams.get("from")!);
    expect(span).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it("does nothing until enabled", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useNextFree({ ...base, enabled: false }));
    expect(result.current).toMatchObject({ loading: false, earliest: null, error: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an error when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { message: "no" } }, 500)));
    const { result } = renderHook(() => useNextFree(base));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.loading).toBe(false);
  });
});
