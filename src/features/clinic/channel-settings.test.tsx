/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelSettings } from "@/lib/inbox-contracts";
import { TestQueryProvider } from "@/test/query-wrapper";

import { ChannelSettingsPanel } from "./channel-settings";

vi.mock("./clinic-catalog", () => ({ useCatalogLookups: () => ({ database: true }) }));

const settings: ChannelSettings = {
  whatsapp: { enabled: true, configured: false, templates: [
    { key: "reminder", language: "en", status: "approved", reason: null },
    { key: "cancelled", language: "en", status: "rejected", reason: "Wording looks promotional" },
  ] },
  sms: { enabled: false, configured: true, provider: "msg91", templates: [{ key: "reminder", language: "en", status: "pending", reason: null }] },
};

let puts: unknown[];
let putStatus: number;

beforeEach(() => {
  puts = [];
  putStatus = 204;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      puts.push(JSON.parse(String(init.body)));
      return putStatus === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ error: { code: "x", message: "Nope" } }), { status: putStatus });
    }
    return new Response(JSON.stringify({ data: settings }), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const renderPanel = () => render(<TestQueryProvider><ChannelSettingsPanel /></TestQueryProvider>);

describe("ChannelSettingsPanel", () => {
  it("shows the not-connected banner and each template's status, with a rejected reason", async () => {
    renderPanel();
    expect(await screen.findByText(/Kalendr's WhatsApp number isn't connected yet; messages go by email until it is/)).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText("Waiting for approval")).toBeInTheDocument();
    expect(screen.getByText("Rejected: Wording looks promotional")).toBeInTheDocument();
  });

  it("saves a switch change and flips it at once", async () => {
    const user = userEvent.setup();
    renderPanel();
    const sms = await screen.findByRole("switch", { name: "SMS" });
    expect(sms).not.toBeChecked();
    await user.click(sms);
    await waitFor(() => expect(puts).toEqual([{ smsEnabled: true }]));
  });

  it("puts the switch back when the save fails", async () => {
    const user = userEvent.setup();
    putStatus = 500;
    renderPanel();
    const whatsapp = await screen.findByRole("switch", { name: "WhatsApp" });
    await user.click(whatsapp);
    await waitFor(() => expect(puts).toEqual([{ whatsappEnabled: false }]));
    await waitFor(() => expect(screen.getByRole("switch", { name: "WhatsApp" })).toBeChecked());
  });
});
