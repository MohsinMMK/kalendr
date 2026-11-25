/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiKeyView } from "@/server/api-keys-contracts";
import type { WebhookDeliveryView, WebhookEndpointView } from "@/server/webhooks/contracts";
import { ToastProvider } from "@/components/ui/toast";
import { TestQueryProvider } from "@/test/query-wrapper";

import { DevelopersSettings } from "./developers-settings";
import { StaffAccessProvider } from "./staff-access";
import { permissionKeys } from "@/lib/permissions";

let database = true;
vi.mock("./clinic-catalog", () => ({ useCatalogLookups: () => ({ database }) }));

const key = (extra: Partial<ApiKeyView> = {}): ApiKeyView => ({
  id: "key-1", name: "Website widget", prefix: "kal_live_Ab12Cd", scopes: ["services:read", "availability:read", "appointments:read"], mode: "live",
  lastUsedAt: null, expiresAt: "2099-01-01T00:00:00.000Z", revokedAt: null, createdAt: "2026-01-01T00:00:00.000Z", ...extra,
});
const endpoint = (extra: Partial<WebhookEndpointView> = {}): WebhookEndpointView => ({
  id: "wh-1", url: "https://crm.example.com/hooks", description: "CRM", events: ["appointment.created", "appointment.cancelled"], status: "active", disabledReason: null,
  consecutiveFailures: 0, version: 3, createdAt: "2026-01-01T00:00:00.000Z", lastDelivery: { status: "succeeded", statusCode: 200, at: "2026-02-01T10:00:00.000Z" }, ...extra,
});
const delivery = (id: string, extra: Partial<WebhookDeliveryView> = {}): WebhookDeliveryView => ({
  id, endpointId: "wh-1", eventId: `ev-${id}`, eventType: "appointment.created", status: "succeeded", attempt: 1, statusCode: 200, durationMs: 120,
  errorCode: null, nextAttemptAt: null, lastAttemptAt: "2026-02-01T10:00:00.000Z", isTest: false, createdAt: "2026-02-01T10:00:00.000Z", ...extra,
});

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined;
let handlers: Handler[];
let calls: { url: string; method: string; body: unknown }[];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  database = true;
  handlers = [];
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    calls.push({ url: input, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    for (const handler of handlers) { const answer = await handler(input, init); if (answer) return answer; }
    return json({ error: { code: "not_found", message: "Not mocked" } }, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const when = (method: string, path: RegExp | string, answer: () => Response) => handlers.push((url, init) => {
  const matches = typeof path === "string" ? url === path : path.test(url);
  return matches && (init?.method ?? "GET") === method ? answer() : undefined;
});

function renderScreen(role: "owner" | "admin" = "owner") {
  return render(<ToastProvider><TestQueryProvider><StaffAccessProvider role={role} permissions={permissionKeys} userId={null}><DevelopersSettings /></StaffAccessProvider></TestQueryProvider></ToastProvider>);
}

describe("Developers: API keys", () => {
  it("shows a loading state, then the keys with prefix, scopes, last used and expiry", async () => {
    when("GET", "/api/staff/api-keys", () => json({ data: { keys: [key(), key({ id: "k2", name: "Old script", prefix: "kal_test_Zz99Yy", mode: "test", lastUsedAt: "2026-02-20T09:00:00.000Z", revokedAt: "2026-03-01T00:00:00.000Z" })] } }));
    renderScreen();
    expect(screen.getByRole("status", { name: "Loading API keys" })).toBeInTheDocument();
    expect(await screen.findByText("Website widget")).toBeInTheDocument();
    expect(screen.getByText("kal_live_Ab12Cd…")).toBeInTheDocument();
    expect(screen.getAllByText("Read services").length).toBeGreaterThan(0);
    expect(screen.getAllByText("+1 more").length).toBeGreaterThan(0);
    expect(screen.getByText("Never")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    // The revoked one sits in its own list and has no menu.
    const revoked = screen.getByRole("list", { name: "Revoked and expired API keys" });
    expect(within(revoked).getByText("Revoked", { selector: "span" })).toBeInTheDocument();
    expect(within(revoked).queryByRole("button")).toBeNull();
  });

  it("shows an empty state with a Create key button", async () => {
    when("GET", "/api/staff/api-keys", () => json({ data: { keys: [] } }));
    renderScreen();
    expect(await screen.findByText("No API keys yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create key" })).toBeEnabled();
  });

  it("shows an error with Retry that loads again", async () => {
    let fail = true;
    when("GET", "/api/staff/api-keys", () => (fail ? json({ error: { code: "x", message: "The server is busy." } }, 500) : json({ data: { keys: [] } })));
    renderScreen();
    expect(await screen.findByText("API keys could not be loaded")).toBeInTheDocument();
    expect(screen.getByText("The server is busy.")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByText("No API keys yet")).toBeInTheDocument();
  });

  it("gives a non-owner a plain explanation and a disabled Create key", async () => {
    when("GET", "/api/staff/api-keys", () => json({ data: { keys: [key()] } }));
    renderScreen("admin");
    expect(await screen.findByText(/Only the owner can create an API key/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create key" })).toBeDisabled();
  });

  it("creates a key, shows it once with a warning, and lists it by prefix afterwards", async () => {
    let keys: ApiKeyView[] = [];
    when("GET", "/api/staff/api-keys", () => json({ data: { keys } }));
    when("POST", "/api/staff/api-keys", () => {
      const created = key({ id: "new", name: "Booking widget", prefix: "kal_live_Qq77Ww" });
      keys = [created];
      return json({ data: { key: created, secret: "kal_live_Qq77Ww-the-rest-of-the-secret-value-xxxxxxxx" } }, 201);
    });
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole("button", { name: "Create key" }));
    const dialog = await screen.findByRole("dialog", { name: "Create an API key" });
    await user.type(within(dialog).getByLabelText("Name"), "Booking widget");
    await user.click(within(dialog).getByRole("button", { name: "Booking widget" }));
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));

    const reveal = await screen.findByRole("dialog", { name: "Copy your new key" });
    expect(within(reveal).getByText("We cannot show this again")).toBeInTheDocument();
    expect(within(reveal).getByLabelText("API key")).toHaveValue("kal_live_Qq77Ww-the-rest-of-the-secret-value-xxxxxxxx");
    expect(within(reveal).getByRole("button", { name: "Copy api key" })).toBeInTheDocument();
    const post = calls.find((call) => call.method === "POST");
    expect(post?.body).toMatchObject({ name: "Booking widget", mode: "live", scopes: ["services:read", "staff:read", "availability:read", "appointments:write", "customers:write"] });

    await user.click(within(reveal).getByRole("button", { name: "I have saved it" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Copy your new key" })).toBeNull());
    expect(await screen.findByText("kal_live_Qq77Ww…")).toBeInTheDocument();
    // The secret is gone from the page.
    expect(screen.queryByDisplayValue(/the-rest-of-the-secret/)).toBeNull();
  });

  it("drops write options when a test key is chosen and checks the form before sending", async () => {
    when("GET", "/api/staff/api-keys", () => json({ data: { keys: [] } }));
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole("button", { name: "Create key" }));
    const dialog = await screen.findByRole("dialog", { name: "Create an API key" });
    await user.click(within(dialog).getByRole("button", { name: "Full access" }));
    await user.click(within(dialog).getByRole("radio", { name: /Test/ }));
    expect(within(dialog).getByRole("checkbox", { name: /Book and change appointments/ })).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getByRole("checkbox", { name: /Read services/ })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));
    expect(await within(dialog).findByText("Give the key a name.")).toBeInTheDocument();
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("shows the server's message beside the field it names", async () => {
    when("GET", "/api/staff/api-keys", () => json({ data: { keys: [] } }));
    when("POST", "/api/staff/api-keys", () => json({ error: { code: "validation_error", message: "Please check the highlighted fields.", fieldErrors: { name: ["That name is not allowed."] } } }, 400));
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole("button", { name: "Create key" }));
    const dialog = await screen.findByRole("dialog", { name: "Create an API key" });
    await user.type(within(dialog).getByLabelText("Name"), "Anything");
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));
    expect(await within(dialog).findByText("That name is not allowed.")).toBeInTheDocument();
  });

  it("revokes from the row menu after a confirmation", async () => {
    let revoked = false;
    when("GET", "/api/staff/api-keys", () => json({ data: { keys: [key({ revokedAt: revoked ? "2026-03-01T00:00:00.000Z" : null })] } }));
    when("POST", "/api/staff/api-keys/key-1/revoke", () => { revoked = true; return json({ data: { key: key({ revokedAt: "2026-03-01T00:00:00.000Z" }) } }); });
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole("button", { name: "More for Website widget" }));
    await user.click(await screen.findByRole("menuitem", { name: "Revoke key" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Revoke this key?" });
    expect(within(confirm).getByText(/will stop working at once/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Revoke key" }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith("/revoke") && call.method === "POST")).toBe(true));
    expect(await screen.findByRole("list", { name: "Revoked and expired API keys" })).toBeInTheDocument();
  });

  it("says plainly that the preview cannot do this", () => {
    database = false;
    renderScreen();
    expect(screen.getByText(/aren't available in the preview/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});

async function openWebhooks() {
  const user = userEvent.setup();
  renderScreen();
  await user.click(screen.getByRole("tab", { name: "Webhooks" }));
  return user;
}

describe("Developers: webhooks", () => {
  beforeEach(() => when("GET", "/api/staff/api-keys", () => json({ data: { keys: [] } })));

  it("shows loading, then the empty state", async () => {
    when("GET", "/api/staff/webhooks", () => json({ data: { endpoints: [] } }));
    await openWebhooks();
    expect(await screen.findByText("No webhook addresses yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add address" })).toBeEnabled();
  });

  it("shows an error with Retry", async () => {
    let fail = true;
    when("GET", "/api/staff/webhooks", () => (fail ? json({ error: { code: "x", message: "Try later." } }, 503) : json({ data: { endpoints: [] } })));
    const user = await openWebhooks();
    expect(await screen.findByText("Webhooks could not be loaded")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByText("No webhook addresses yet")).toBeInTheDocument();
  });

  it("shows each status and lets the owner turn a failed address back on", async () => {
    let failing = true;
    when("GET", "/api/staff/webhooks", () => json({ data: { endpoints: [
      endpoint(),
      endpoint({ id: "wh-2", url: "https://b.example.com/x", description: null, status: "disabled", disabledReason: "owner" }),
      endpoint({ id: "wh-3", url: "https://c.example.com/x", description: null, status: failing ? "disabled" : "active", disabledReason: failing ? "repeated_failure" : null, consecutiveFailures: 8, version: 5 }),
    ] } }));
    when("PATCH", "/api/staff/webhooks/wh-3", () => { failing = false; return json({ data: { endpoint: endpoint({ id: "wh-3" }) } }); });
    const user = await openWebhooks();
    expect(await screen.findByText("Disabled by you")).toBeInTheDocument();
    expect(screen.getByText("Turned off after repeated failures")).toBeInTheDocument();
    expect(screen.getByText(/failed 8 times in a row/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Turn back on" }));
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ status: "active", expectedVersion: 5 }));
    await waitFor(() => expect(screen.queryByText("Turned off after repeated failures")).toBeNull());
  });

  it("sends a test event and opens the delivery log with load more and resend", async () => {
    when("GET", "/api/staff/webhooks", () => json({ data: { endpoints: [endpoint()] } }));
    when("POST", "/api/staff/webhooks/wh-1/test", () => json({ data: { deliveryId: "d-test" } }, 202));
    when("POST", "/api/staff/webhooks/deliveries/d1/resend", () => json({ data: { deliveryId: "d1b" } }, 202));
    handlers.push((url) => {
      if (!url.includes("/api/staff/webhooks/wh-1/deliveries")) return undefined;
      return url.includes("cursor=next-page")
        ? json({ data: { deliveries: [delivery("d3", { eventType: "appointment.cancelled", status: "gave_up", statusCode: 500, attempt: 6 })], nextCursor: null } })
        : json({ data: { deliveries: [delivery("d1"), delivery("d2", { status: "retrying", statusCode: 502, attempt: 2, nextAttemptAt: "2026-02-01T11:00:00.000Z", isTest: true })], nextCursor: "next-page" } });
    });
    const user = await openWebhooks();
    await user.click(await screen.findByRole("button", { name: /Send test/ }));
    expect(await screen.findByText("Test event queued")).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Recent deliveries to CRM" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("Will try again")).toBeInTheDocument();
    expect(within(table).getByText("502")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await within(table).findByText("Gave up")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    await user.click(within(table).getAllByRole("button", { name: /^Resend/ })[0]!);
    await waitFor(() => expect(calls.some((call) => call.url.endsWith("/deliveries/d1/resend"))).toBe(true));
  });

  it("adds an address, checks https before sending, and shows the secret once", async () => {
    let endpoints: WebhookEndpointView[] = [];
    when("GET", "/api/staff/webhooks", () => json({ data: { endpoints } }));
    when("POST", "/api/staff/webhooks", () => { const created = endpoint({ id: "new", url: "https://new.example.com/h" }); endpoints = [created]; return json({ data: { endpoint: created, secret: "whsec_super_secret_value" } }, 201); });
    const user = await openWebhooks();
    await user.click(await screen.findByRole("button", { name: "Add address" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a webhook address" });
    await user.type(within(dialog).getByLabelText("Address"), "http://insecure.example.com");
    await user.click(within(dialog).getByRole("button", { name: "Add address" }));
    expect(await within(dialog).findByText("Addresses must use https and a public address.")).toBeInTheDocument();
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    await user.clear(within(dialog).getByLabelText("Address"));
    await user.type(within(dialog).getByLabelText("Address"), "https://new.example.com/h");
    await user.click(within(dialog).getByRole("button", { name: "Add address" }));
    const reveal = await screen.findByRole("dialog", { name: "Copy your signing secret" });
    expect(within(reveal).getByLabelText("Signing secret")).toHaveValue("whsec_super_secret_value");
    expect(within(reveal).getByText("We cannot show this again")).toBeInTheDocument();
    await user.click(within(reveal).getByRole("button", { name: "I have saved it" }));
    expect(await screen.findByText("https://new.example.com/h")).toBeInTheDocument();
  });

  it("shows the server's address error beside the field", async () => {
    when("GET", "/api/staff/webhooks", () => json({ data: { endpoints: [] } }));
    when("POST", "/api/staff/webhooks", () => json({ error: { code: "validation_error", message: "Check the address.", fieldErrors: { url: ["That address points at a private network."] } } }, 400));
    const user = await openWebhooks();
    await user.click(await screen.findByRole("button", { name: "Add address" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a webhook address" });
    await user.type(within(dialog).getByLabelText("Address"), "https://internal.example.com");
    await user.click(within(dialog).getByRole("button", { name: "Add address" }));
    expect(await within(dialog).findByText("That address points at a private network.")).toBeInTheDocument();
  });

  it("makes a new secret after a confirmation and deletes after a confirmation", async () => {
    when("GET", "/api/staff/webhooks", () => json({ data: { endpoints: [endpoint()] } }));
    when("POST", "/api/staff/webhooks/wh-1/rotate-secret", () => json({ data: { endpoint: endpoint(), secret: "whsec_rotated" } }));
    when("DELETE", "/api/staff/webhooks/wh-1", () => new Response(null, { status: 204 }));
    const user = await openWebhooks();
    await user.click(await screen.findByRole("button", { name: "More for CRM" }));
    await user.click(await screen.findByRole("menuitem", { name: "Make a new secret" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Make new secret" }));
    const reveal = await screen.findByRole("dialog", { name: "Copy your new signing secret" });
    expect(within(reveal).getByLabelText("Signing secret")).toHaveValue("whsec_rotated");
    await user.click(within(reveal).getByRole("button", { name: "I have saved it" }));
    await user.click(await screen.findByRole("button", { name: "More for CRM" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete address" }));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
  });
});
