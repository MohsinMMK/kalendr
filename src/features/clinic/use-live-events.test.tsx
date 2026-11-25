import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jittered, useLiveEvents, type LiveChange } from "./use-live-events";

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data: unknown = {}) {
    this.readyState = FakeEventSource.OPEN;
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data: JSON.stringify(data) }));
  }

  fail(closed: boolean) {
    this.readyState = closed ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING;
    this.onerror?.();
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

describe("live events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("turns a burst of changes into one refetch that says what changed", () => {
    const onChange = vi.fn<(change: LiveChange) => void>();
    renderHook(() => useLiveEvents(onChange));
    const source = FakeEventSource.instances[0]!;

    act(() => {
      source.emit("ready");
      source.emit("change", { kind: "appointment" });
      source.emit("change", { kind: "queue" });
      vi.advanceTimersByTime(300);
    });

    expect(onChange).toHaveBeenCalledOnce();
    expect([...(onChange.mock.calls[0]![0] as Set<string>)]).toEqual(["appointment", "queue"]);
  });

  it("refetches everything after reconnecting, but not on the first connection", () => {
    const onChange = vi.fn<(change: LiveChange) => void>();
    renderHook(() => useLiveEvents(onChange));
    const source = FakeEventSource.instances[0]!;

    act(() => {
      source.emit("ready");
      vi.advanceTimersByTime(300);
    });
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      source.fail(false);
      source.emit("ready");
      vi.advanceTimersByTime(300);
    });
    expect(onChange).toHaveBeenCalledWith("all");
  });

  it("polls every 30 seconds while refused, then tries the stream again", () => {
    const onChange = vi.fn<(change: LiveChange) => void>();
    renderHook(() => useLiveEvents(onChange));

    act(() => {
      FakeEventSource.instances[0]!.fail(true);
      vi.advanceTimersByTime(30_000);
    });
    expect(onChange).toHaveBeenCalledWith("all");

    act(() => { vi.advanceTimersByTime(30_000); });
    expect(FakeEventSource.instances).toHaveLength(2);

    act(() => {
      onChange.mockClear();
      FakeEventSource.instances[1]!.emit("ready");
      vi.advanceTimersByTime(60_000);
    });
    // Polling stopped once the stream was back; only the catch-up refetch ran.
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("closes the stream when the screen goes away", () => {
    const { unmount } = renderHook(() => useLiveEvents(vi.fn()));
    unmount();
    expect(FakeEventSource.instances[0]!.readyState).toBe(FakeEventSource.CLOSED);
  });

  it("spreads reconnects between the wait and twice the wait", () => {
    expect(jittered(1_000, () => 0)).toBe(1_000);
    expect(jittered(1_000, () => 0.5)).toBe(1_500);
  });
});
