/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "@/components/ui/toast";
import type { AppCard, AppDetail } from "@/lib/apps/catalog";
import { permissionKeys } from "@/lib/permissions";
import { TestQueryProvider } from "@/test/query-wrapper";

import { AppsSettings } from "./apps-settings";
import { StaffAccessProvider } from "./staff-access";

let database = true;
vi.mock("./clinic-catalog", () => ({ useCatalogLookups: () => ({ database }) }));
vi.mock("./step-up-dialog", () => ({ useStepUp: () => ({ runWithStepUp: <T,>(run: () => Promise<T>) => run() }) }));

const card = (extra: Partial<AppCard>): AppCard => ({
  key: "slack", name: "Slack", tagline: "Post new bookings to a channel.", category: "messaging", kind: "native", state: "available", statusText: null,
  dataSent: ["The service name and the time."], manage: null, needsUpgrade: false, ...extra,
});
const detail = (extra: Partial<AppDetail> = {}): AppDetail => ({
  ...card({}), description: "Your team sees each booking in Slack.",
  credentialFields: [{ key: "botToken", label: "Slack bot token", help: "Copy it from your Slack app.", placeholder: "xoxb-…" }],
  settingFields: [
    { kind: "text", key: "channel", label: "Channel", maxLength: 80 },
    { kind: "switch", key: "showFirstName", label: "Include the customer's first name" },
  ],
  settings: { channel: "#bookings", showFirstName: false }, hasCredentials: false, version: null, installedAt: null, disabledReason: null, uninstallNote: null, events: [], ...extra,
});

type Handler = (url: string, init: RequestInit | undefined) => Response | undefined;
let handlers: Handler[];
let calls: { url: string; method: string; body: unknown }[];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const when = (method: string, path: RegExp | string, answer: () => Response) => handlers.push((url, init) => {
  const matches = typeof path === "string" ? url === path : path.test(url);
  return matches && (init?.method ?? "GET") === method ? answer() : undefined;
});

beforeEach(() => {
  database = true;
  handlers = [];
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    calls.push({ url: input, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    for (const handler of handlers) { const answer = handler(input, init); if (answer) return answer; }
    return json({ error: { code: "not_found", message: "Not mocked" } }, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderScreen(role: "owner" | "receptionist" = "owner") {
  return render(<ToastProvider><TestQueryProvider><StaffAccessProvider role={role} permissions={permissionKeys} userId={null}><AppsSettings /></StaffAccessProvider></TestQueryProvider></ToastProvider>);
}

const list = [
  card({}),
  card({ key: "hubspot", name: "HubSpot", tagline: "Keep customers in HubSpot up to date.", category: "crm" }),
  card({ key: "webhooks", name: "Webhooks", tagline: "Send events to your own software.", category: "developer", kind: "connected", state: "connected", statusText: "2 addresses receiving events", manage: { section: "developers", label: "Open developer tools" } }),
];

describe("the Apps page", () => {
  it("says it needs the database in the preview", () => {
    database = false;
    renderScreen();
    expect(screen.getByText(/aren.t available in the preview/)).toBeInTheDocument();
  });

  it("shows loading, then connected and available apps together", async () => {
    when("GET", "/api/staff/apps", () => json({ data: { apps: list } }));
    renderScreen();
    expect(screen.getByRole("status", { name: "Loading apps" })).toBeInTheDocument();
    const connected = await screen.findByRole("region", { name: "Connected" });
    expect(within(connected).getByText("Webhooks")).toBeInTheDocument();
    expect(within(connected).getByText("2 addresses receiving events")).toBeInTheDocument();
    const more = screen.getByRole("region", { name: "More apps" });
    expect(within(more).getAllByRole("button", { name: "Install" })).toHaveLength(2);
  });

  it("offers a retry when the list fails", async () => {
    let failing = true;
    handlers.push(() => (failing ? json({ error: { code: "x", message: "The database is busy." } }, 500) : json({ data: { apps: list } })));
    renderScreen();
    expect(await screen.findByText("Apps could not be loaded")).toBeInTheDocument();
    failing = false;
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByText("Slack")).toBeInTheDocument();
  });

  it("searches by name and shows an empty state with a way back", async () => {
    when("GET", "/api/staff/apps", () => json({ data: { apps: list } }));
    renderScreen();
    await screen.findByText("Slack");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search apps" }), "hubs");
    expect(screen.queryByText("Slack")).not.toBeInTheDocument();
    expect(screen.getByText("HubSpot")).toBeInTheDocument();
    await userEvent.clear(screen.getByRole("searchbox", { name: "Search apps" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search apps" }), "zzz");
    expect(screen.getByText("Nothing matches")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear the search" }));
    expect(screen.getByText("Slack")).toBeInTheDocument();
  });

  it("installs an app: shows what it receives, sends the key and the choices, and names a refused field", async () => {
    when("GET", "/api/staff/apps", () => json({ data: { apps: list } }));
    when("GET", "/api/staff/apps/slack", () => json({ data: detail() }));
    let answer = json({ error: { code: "validation_error", message: "Please check the highlighted fields.", fieldErrors: { "credentials.botToken": ["That does not look like a Slack bot token."] } } }, 400);
    handlers.push((url, init) => (url === "/api/staff/apps/slack/install" && init?.method === "POST" ? answer.clone() : undefined));
    renderScreen();
    await userEvent.click((await screen.findAllByRole("button", { name: "Install" }))[0]!);
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText("What this app receives")).toBeInTheDocument();
    expect(within(drawer).getByText("The service name and the time.")).toBeInTheDocument();
    await userEvent.type(within(drawer).getByLabelText("Slack bot token"), "nope");
    await userEvent.click(within(drawer).getByRole("button", { name: "Connect" }));
    expect(await within(drawer).findByText("That does not look like a Slack bot token.")).toBeInTheDocument();
    const sent = calls.find((call) => call.url.endsWith("/install"));
    expect(sent?.body).toEqual({ credentials: { botToken: "nope" }, settings: { channel: "#bookings", showFirstName: false } });

    answer = json({ data: detail({ state: "active", version: 1, hasCredentials: true }) });
    await userEvent.clear(within(drawer).getByLabelText("Slack bot token"));
    await userEvent.type(within(drawer).getByLabelText("Slack bot token"), "xoxb-good");
    await userEvent.click(within(drawer).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(calls.filter((call) => call.url.endsWith("/install"))).toHaveLength(2));
  });

  it("never prefills or prints a saved key when settings open", async () => {
    when("GET", "/api/staff/apps", () => json({ data: { apps: [card({ state: "active" })] } }));
    when("GET", "/api/staff/apps/slack", () => json({ data: detail({ state: "active", version: 2, hasCredentials: true, events: [{ id: "e1", eventType: "appointment.created", outcome: "failed", errorCode: "credential_rejected", createdAt: "2026-11-20T10:00:00.000Z" }] }) }));
    renderScreen();
    await userEvent.click(await screen.findByRole("button", { name: "Manage" }));
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText("Activity")).toBeInTheDocument();
    expect(within(drawer).getByText(/no longer accepts the saved key/)).toBeInTheDocument();
    expect(within(drawer).queryByLabelText("Slack bot token")).not.toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it("lists signed-in apps and disconnects one after a confirmation", async () => {
    when("GET", "/api/staff/apps", () => json({ data: { apps: list } }));
    when("GET", "/api/staff/oauth/grants", () => json({ data: { grants: [{ id: "g1", clientName: "Kalendr browser extension", clientKind: "builtin", userId: "u", scopes: ["services:read", "links:write"], createdAt: "2026-11-01T00:00:00.000Z", lastUsedAt: null, revokedAt: null, mine: true }] } }));
    when("POST", "/api/staff/oauth/grants/g1/revoke", () => json({ data: { grant: {} } }));
    renderScreen();
    await userEvent.click(screen.getByRole("tab", { name: "Signed in" }));
    expect(await screen.findByText("Kalendr browser extension")).toBeInTheDocument();
    expect(screen.getByText("Make single-use booking links")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/staff/oauth/grants/g1/revoke" && call.method === "POST")).toBe(true));
  });

  it("hides the registration tab from people who cannot manage keys", () => {
    when("GET", "/api/staff/apps", () => json({ data: { apps: list } }));
    render(<ToastProvider><TestQueryProvider><StaffAccessProvider role="receptionist" permissions={["apps.manage"]} userId={null}><AppsSettings /></StaffAccessProvider></TestQueryProvider></ToastProvider>);
    expect(screen.queryByRole("tab", { name: "Your own apps" })).not.toBeInTheDocument();
  });
});
