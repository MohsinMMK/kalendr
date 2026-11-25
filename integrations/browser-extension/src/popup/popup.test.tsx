/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Reply, Request, ReplyData } from "../lib/messages";
import { App } from "./app";
import { BridgeContext, type Bridge } from "./bridge";

type Handlers = { [K in Request["type"]]?: (request: Extract<Request, { type: K }>) => Reply<K> | Promise<Reply<K>> };

let handlers: Handlers;
let sent: Request[];
const bridge: Bridge = async (request) => {
  sent.push(request);
  const handler = handlers[request.type] as ((request: Request) => unknown) | undefined;
  if (!handler) return { ok: false, error: { kind: "unexpected", message: "not mocked" } } as never;
  return (await handler(request)) as never;
};
const ok = <K extends Request["type"]>(data: ReplyData[K]): Reply<K> => ({ ok: true, data });

const services = [
  { id: "s1", name: "Dental cleaning", url: "https://k.test/book/lotus/cleaning", hidden: false, durationMinutes: 30 },
  { id: "s2", name: "Whitening", url: "https://k.test/book/lotus/whitening", hidden: true, durationMinutes: 60 },
];
const today = { date: "2026-12-01", timezone: "Asia/Kolkata", bookings: [
  { id: "a1", startsAt: "2026-12-01T04:00:00.000Z", endsAt: "2026-12-01T04:30:00.000Z", status: "booked", serviceName: "Dental cleaning", firstName: "Asha" },
  { id: "a2", startsAt: "2026-12-01T05:00:00.000Z", endsAt: "2026-12-01T05:30:00.000Z", status: "checked_in", serviceName: "Whitening", firstName: "Ravi" },
] };

let clipboard: { text: string[]; items: ClipboardItem[] };

beforeEach(() => {
  sent = [];
  clipboard = { text: [], items: [] };
  handlers = {
    status: () => ok<"status">({ connected: true, pending: null }),
    me: () => ok<"me">({ businessName: "Lotus Dental", businessSlug: "lotus", scopes: [] }),
    services: () => ok<"services">(services),
    today: () => ok<"today">(today),
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async (value: string) => { clipboard.text.push(value); }), write: vi.fn(async (items: ClipboardItem[]) => { clipboard.items.push(...items); }) },
  });
  vi.stubGlobal("ClipboardItem", class { constructor(readonly data: Record<string, Blob>) {} });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const renderApp = () => render(<BridgeContext.Provider value={bridge}><App /></BridgeContext.Provider>);

describe("the popup when connected", () => {
  it("lists the services with the business name, and copies a link", async () => {
    renderApp();
    expect(await screen.findByRole("heading", { name: "Lotus Dental" })).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Services" });
    expect(within(list).getByText("Dental cleaning")).toBeInTheDocument();
    expect(within(list).getByText("60 min · link only")).toBeInTheDocument();
    await userEvent.click(within(list).getAllByRole("button", { name: "Copy link" })[0]!);
    await waitFor(() => expect(clipboard.text).toEqual(["https://k.test/book/lotus/cleaning"]));
    expect(await screen.findByText("Link to Dental cleaning copied.")).toBeInTheDocument();
  });

  it("copies open times for an email as rich text and plain text", async () => {
    handlers.emailTimes = (request) => {
      expect(request.serviceId).toBe("s1");
      return ok<"emailTimes">({ times: [{ startsAt: "2026-12-02T04:00:00.000Z", label: "Wed 2 Dec, 9:30 am", href: "https://k.test/book/lotus/cleaning?time=1" }], html: "<ul><li><a href=\"x\">Wed</a></li></ul>" });
    };
    renderApp();
    await userEvent.click((await screen.findAllByRole("button", { name: "More for Dental cleaning" }))[0]!);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Copy times for an email" }));
    await waitFor(() => expect(clipboard.items).toHaveLength(1));
    expect(await screen.findByText("Times copied. Paste them into your email.")).toBeInTheDocument();
  });

  it("makes a single-use link and copies it", async () => {
    handlers.createLink = (request) => {
      expect(request).toMatchObject({ serviceId: "s1" });
      return ok<"createLink">({ id: "l1", url: "https://k.test/l/once" });
    };
    renderApp();
    await userEvent.click((await screen.findAllByRole("button", { name: "More for Dental cleaning" }))[0]!);
    await userEvent.click(await screen.findByRole("menuitem", { name: "New single-use link" }));
    await waitFor(() => expect(clipboard.text).toEqual(["https://k.test/l/once"]));
    expect(await screen.findByText(/Single-use link copied/)).toBeInTheDocument();
  });

  it("shows today's bookings with times in the business's zone and first names only", async () => {
    renderApp();
    await userEvent.click(await screen.findByRole("tab", { name: "Today" }));
    const list = await screen.findByRole("list", { name: "Today's bookings" });
    expect(within(list).getByText("Asha")).toBeInTheDocument();
    expect(within(list).getByText("9:30 am")).toBeInTheDocument();
    expect(within(list).getByText("Dental cleaning · Booked")).toBeInTheDocument();
    expect(within(list).getByText("Whitening · Arrived")).toBeInTheDocument();
  });

  it("says when nothing is booked, and when a list cannot load, with a way to try again", async () => {
    handlers.today = () => ok<"today">({ ...today, bookings: [] });
    renderApp();
    await userEvent.click(await screen.findByRole("tab", { name: "Today" }));
    expect(await screen.findByText("Nothing booked today.")).toBeInTheDocument();

    cleanup();
    let failing = true;
    handlers.services = () => (failing ? { ok: false, error: { kind: "api", message: "Kalendr could not be reached. Check your connection.", code: "network", status: 0 } } : ok<"services">(services));
    renderApp();
    expect(await screen.findByRole("alert")).toHaveTextContent("Kalendr could not be reached");
    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Services" })).toBeInTheDocument();
  });

  it("goes back to Connect the moment Kalendr says it was signed out (a revoked key)", async () => {
    handlers.services = () => ({ ok: false, error: { kind: "signed_out", message: "Kalendr signed this extension out. Connect it again." } });
    renderApp();
    expect(await screen.findByRole("button", { name: "Connect" })).toBeInTheDocument();
  });

  it("disconnects from the menu", async () => {
    handlers.disconnect = () => ok<"disconnect">(null);
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Disconnect this browser" }));
    expect(await screen.findByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(sent.some((request) => request.type === "disconnect")).toBe(true);
  });

  it("opens the menu with the keyboard and closes it with Escape", async () => {
    renderApp();
    const more = await screen.findByRole("button", { name: "More" });
    more.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(await screen.findByRole("menuitem", { name: "Disconnect this browser" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(more).toHaveFocus();
  });
});

describe("the popup when not connected", () => {
  beforeEach(() => { handlers.status = () => ok<"status">({ connected: false, pending: null }); });

  it("starts a connection, shows the code and a link to approve it, and finishes by itself", async () => {
    handlers["connect.start"] = () => ok<"connect.start">({ userCode: "BCDF-GHJK", verificationUri: "https://k.test/oauth/device?code=BCDF-GHJK", expiresAt: Date.now() + 600_000, interval: 3 });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(await screen.findByText("BCDF-GHJK")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Open Kalendr" });
    expect(link).toHaveAttribute("href", "https://k.test/oauth/device?code=BCDF-GHJK");
    expect(link).toHaveAttribute("rel", "noreferrer");

    let polls = 0;
    handlers["connect.poll"] = () => ok<"connect.poll">(++polls < 2 ? { state: "waiting" } : { state: "connected" });
    expect(await screen.findByRole("heading", { name: "Lotus Dental" }, { timeout: 10_000 })).toBeInTheDocument();
    expect(polls).toBe(2);
  }, 15_000);

  it("picks up a code that was already showing when the popup was closed", async () => {
    handlers.status = () => ok<"status">({ connected: false, pending: { userCode: "WXZT-BCDF", verificationUri: "https://k.test/x", expiresAt: Date.now() + 60_000, interval: 5 } });
    renderApp();
    expect(await screen.findByText("WXZT-BCDF")).toBeInTheDocument();
  });

  it("tells the person when they said no or the code ran out", async () => {
    handlers["connect.start"] = () => ok<"connect.start">({ userCode: "BCDF-GHJK", verificationUri: "https://k.test/x", expiresAt: Date.now() + 600_000, interval: 3 });
    handlers["connect.poll"] = () => ok<"connect.poll">({ state: "denied" });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert", {}, { timeout: 6_000 })).toHaveTextContent("You chose not to connect");
  }, 10_000);

  it("connects with a pasted API key, and shows why a bad one was refused", async () => {
    let answer: Reply<"connect.key"> = { ok: false, error: { kind: "api", message: "Kalendr does not recognise that key.", code: "invalid_api_key", status: 401 } };
    handlers["connect.key"] = (request) => { expect(request.key).toMatch(/^kal_live_/); return answer; };
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "Use an API key instead" }));
    await userEvent.type(screen.getByLabelText("API key"), " kal_live_abc ");
    await userEvent.click(screen.getByRole("button", { name: "Use this key" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("does not recognise that key");
    answer = ok<"connect.key">(null);
    await userEvent.click(screen.getByRole("button", { name: "Use this key" }));
    expect(await screen.findByRole("heading", { name: "Lotus Dental" })).toBeInTheDocument();
  });

  it("never asks for a password or shows a sign-in form", async () => {
    renderApp();
    await screen.findByRole("button", { name: "Connect" });
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    void act;
  });
});
