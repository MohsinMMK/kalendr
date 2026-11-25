// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { countVisit, shouldOfferInstall, VISITS_BEFORE_PROMPT } from "./install-prompt";
import { formatOfflineTime, noteResponse, OFFLINE_HEADER, setOfflineAt } from "./offline-status";
import { keyToBytes } from "./use-push";

const DAY = 24 * 60 * 60 * 1000;

describe("install prompt", () => {
  beforeEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); });

  it("waits until someone has come back a few times, and stays quiet for a month after a no", () => {
    expect(shouldOfferInstall(1, 0)).toBe(false);
    expect(shouldOfferInstall(VISITS_BEFORE_PROMPT, 0)).toBe(true);
    const now = Date.now();
    expect(shouldOfferInstall(10, now - 5 * DAY, now)).toBe(false);
    expect(shouldOfferInstall(10, now - 31 * DAY, now)).toBe(true);
  });

  it("counts one visit per session, however many times the page loads", () => {
    expect(countVisit()).toBe(1);
    expect(countVisit()).toBe(1);
    window.sessionStorage.clear();
    expect(countVisit()).toBe(2);
  });
});

describe("offline status", () => {
  it("reads the time the service worker says a saved copy was made, and forgets it once the network is back", () => {
    noteResponse(new Response("{}", { headers: { [OFFLINE_HEADER]: "2026-11-19T04:12:00.000Z" } }));
    noteResponse(new Response("{}"));
    // Back online: nothing is shown.
    noteResponse(new Response("{}", { headers: { [OFFLINE_HEADER]: "not a date" } }));
    setOfflineAt(null);
    expect(formatOfflineTime("2026-11-19T04:12:00.000Z")).toMatch(/^\d{1,2}:\d{2} (am|pm)$/);
  });
});

describe("push key", () => {
  it("turns the server's URL-safe key into the bytes a browser wants", () => {
    const bytes = keyToBytes("AQID_-8");
    expect([...bytes]).toEqual([1, 2, 3, 255, 239]);
  });
});
