/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "@/components/ui/toast";
import type { AssistantSettingsView } from "@/lib/assistant-contracts";

import { AssistantSettings } from "./assistant-settings";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const view = (overrides: Partial<AssistantSettingsView> = {}): AssistantSettingsView => ({
  enabledWeb: false, enabledWhatsapp: false, enabledSms: false, tone: "friendly", handoffRule: "balanced", businessFacts: "", retentionDays: 90, version: 0,
  available: true, modelReady: true, mode: "live", usedTokens: 300_000, tokenCap: 3_000_000, ...overrides,
});

function setup(options: { settings?: AssistantSettingsView; handoffs?: unknown[]; settingsStatus?: number } = {}) {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.startsWith("/api/staff/assistant/settings") && method === "GET") {
      if (options.settingsStatus) return new Response(JSON.stringify({ error: { code: "x", message: "The settings could not be loaded." } }), { status: options.settingsStatus });
      return new Response(JSON.stringify({ data: options.settings ?? view() }));
    }
    if (url.startsWith("/api/staff/assistant/settings") && method === "PUT") return new Response(JSON.stringify({ data: view({ ...(options.settings ?? {}), enabledWeb: true, version: 1 }) }));
    if (url.startsWith("/api/staff/assistant/handoffs")) return new Response(JSON.stringify({ data: { handoffs: options.handoffs ?? [] } }));
    return new Response(JSON.stringify({ data: {} }));
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ToastProvider><AssistantSettings /></ToastProvider></QueryClientProvider>);
  return requests;
}

describe("assistant settings", () => {
  it("shows the switches, the allowance, an empty waiting list, and keeps text messages off", async () => {
    setup();
    expect(await screen.findByRole("switch", { name: "Chat on your booking page" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Text messages" })).toHaveAttribute("aria-disabled", "true");
    expect(await screen.findByText("Nothing waiting")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Allowance used" })).toHaveAttribute("aria-valuenow", "300000");
  });

  it("saves the switch with the version it loaded", async () => {
    const user = userEvent.setup();
    const requests = setup();
    await user.click(await screen.findByRole("switch", { name: "Chat on your booking page" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PUT")).toBe(true));
    expect(requests.find((request) => request.method === "PUT")?.body).toMatchObject({ enabledWeb: true, enabledSms: false, version: 0 });
  });

  it("says when the plan or the model is missing", async () => {
    setup({ settings: view({ available: false, mode: "off", modelReady: false }) });
    expect(await screen.findByText("The assistant is part of the Growth plan and above.")).toBeInTheDocument();
    expect(screen.getByText(/model is not connected on this server yet/)).toBeInTheDocument();
  });

  it("lists chats waiting for a person with the reason and a summary", async () => {
    setup({ handoffs: [{ id: "chat-1", channel: "web", reason: "asked_for_person", handedOffAt: new Date().toISOString(), summary: "Wants to move Friday's visit.", customerName: null }] });
    expect(await screen.findByText("Wants to move Friday's visit.")).toBeInTheDocument();
    expect(screen.getByText("Asked for a person")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Read the chat" })).toBeInTheDocument();
  });

  it("offers a way to try again when the settings cannot load", async () => {
    setup({ settingsStatus: 500 });
    expect(await screen.findByText("The settings could not be loaded.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
