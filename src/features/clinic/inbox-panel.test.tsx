/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TestQueryProvider } from "@/test/query-wrapper";
import { chooseOption } from "@/test/choose-option";
import type { ThreadDetail, ThreadSummary } from "@/lib/inbox-contracts";

import { InboxPanel } from "./inbox-panel";
import { StaffAccessProvider } from "./staff-access";

const device = vi.hoisted(() => ({ mobile: false }));
vi.mock("@/hooks/use-media-query", () => ({ useIsMobile: () => device.mobile, useMediaQuery: () => device.mobile }));
vi.mock("./clinic-catalog", () => ({ useCatalogLookups: () => ({ database: true }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const thread = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id: "thr_1", patientId: "pat_1", patientName: "Asha Menon", channel: "whatsapp", unreadCount: 2,
  lastMessageAt: "2026-11-18T05:00:00.000Z", preview: "Can I come later?", windowOpen: true, assignedToUserId: null, ...over,
});

const detail = (over: Partial<ThreadDetail> = {}, threadOver: Partial<ThreadSummary> = {}): ThreadDetail => ({
  thread: thread(threadOver),
  messages: [
    { id: "m1", direction: "outbound", kind: "template", text: null, templateLabel: "Appointment reminder", status: "delivered", failureCode: null, createdAt: "2026-11-17T05:00:00.000Z" },
    { id: "m2", direction: "inbound", kind: "text", text: "Can I come later?", templateLabel: null, status: "received", failureCode: null, createdAt: "2026-11-18T05:00:00.000Z" },
    { id: "m3", direction: "outbound", kind: "text", text: "Sure, 5pm works", templateLabel: null, status: "failed", failureCode: "window_closed", createdAt: "2026-11-18T05:05:00.000Z" },
  ],
  nextAppointment: { id: "apt_9", startsAt: "2026-11-20T04:30:00.000Z", serviceName: "Dental consultation", practitionerName: "Dr Kavya Rao", status: "booked", confirmationStatus: "unconfirmed" },
  windowClosesAt: "2026-11-19T05:00:00.000Z",
  replyTemplates: [{ key: "reminder", label: "Appointment reminder" }, { key: "booking_confirmed", label: "Booking confirmation" }],
  ...over,
});

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }
let calls: Call[];
let routes: Record<string, () => Response>;

const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });

beforeEach(() => {
  calls = [];
  device.mobile = false;
  // The composer sends on Enter only for a fine pointer (a mouse or trackpad); jsdom has none unless told.
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("pointer: fine"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  routes = {
    "GET /api/staff/threads?filter=all": () => ok([thread(), thread({ id: "thr_2", patientName: "Ravi Iyer", unreadCount: 0, preview: "Thanks" })]),
    "GET /api/staff/threads?filter=unread": () => ok([thread()]),
    "GET /api/staff/threads/thr_1": () => ok(detail()),
    "POST /api/staff/threads/thr_1/read": () => new Response(null, { status: 204 }),
    "POST /api/staff/threads/thr_1/messages": () => ok({ messageId: "m9", status: "queued" }, 201),
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    calls.push({ url: input, method, headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const route = routes[`${method} ${input}`];
    return route ? route() : new Response(JSON.stringify({ error: { code: "not_found", message: "Missing" } }), { status: 404 });
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderPanel(userId: string | null = "user_1") {
  return render(
    <TestQueryProvider>
      <StaffAccessProvider role="receptionist" permissions={["inbox.reply"]} userId={userId}><InboxPanel /></StaffAccessProvider>
    </TestQueryProvider>,
  );
}

describe("the Inbox list", () => {
  it("shows a loading state, then conversations with an unread badge", async () => {
    renderPanel();
    expect(screen.getByRole("status", { name: "Loading conversations" })).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Conversations" });
    expect(within(list).getByText("Asha Menon")).toBeInTheDocument();
    expect(within(list).getByLabelText("2 unread")).toBeInTheDocument();
    expect(within(list).queryByLabelText("0 unread")).toBeNull();
  });

  it("says why it is empty", async () => {
    routes["GET /api/staff/threads?filter=all"] = () => ok([]);
    renderPanel();
    expect(await screen.findByText(/No conversations yet\. Replies from \w+ on WhatsApp land here\./)).toBeInTheDocument();
  });

  it("shows an error with Retry that loads the list", async () => {
    const user = userEvent.setup();
    routes["GET /api/staff/threads?filter=all"] = () => new Response(JSON.stringify({ error: { code: "x", message: "no" } }), { status: 500 });
    renderPanel();
    expect(await screen.findByText("Conversations could not be loaded")).toBeInTheDocument();
    routes["GET /api/staff/threads?filter=all"] = () => ok([thread()]);
    await user.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByText("Asha Menon")).toBeInTheDocument();
  });

  it("filters by the toggle and by name", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText("Ravi Iyer");
    await user.type(screen.getByRole("searchbox"), "ravi");
    expect(screen.queryByText("Asha Menon")).toBeNull();
    await user.clear(screen.getByRole("searchbox"));
    await user.click(screen.getByRole("button", { name: "Unread" }));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/staff/threads?filter=unread")).toBe(true));
    await waitFor(() => expect(screen.queryByText("Ravi Iyer")).toBeNull());
  });
});

describe("a conversation", () => {
  it("opens, marks the thread read, and shows messages, template chip, failure in words and the appointment", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: /Asha Menon/ }));
    expect(await screen.findByText("Sure, 5pm works")).toBeInTheDocument();
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.url === "/api/staff/threads/thr_1/read")).toBe(true));
    const log = screen.getByRole("log", { name: "Messages" });
    expect(within(log).getByText("Template: Appointment reminder")).toBeInTheDocument();
    expect(within(log).getAllByText("Can I come later?")).toHaveLength(1);
    expect(within(log).getByText(/Not delivered/)).toBeInTheDocument();
    expect(within(log).getByText(/more than 24 hours since they wrote/)).toBeInTheDocument();
    expect(screen.getByText(/Dental consultation with Dr Kavya Rao/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open appointment/ })).toHaveAttribute("href", "/appointments/apt_9");
    expect(screen.getByRole("link", { name: "Asha Menon" })).toHaveAttribute("href", "/patients?patient=pat_1");
  });

  it("assigns the thread to the signed-in person", async () => {
    const user = userEvent.setup();
    routes["PUT /api/staff/threads/thr_1/assign"] = () => new Response(null, { status: 204 });
    renderPanel();
    await user.click(await screen.findByRole("button", { name: /Asha Menon/ }));
    await user.click(await screen.findByRole("button", { name: /Assign to me/ }));
    await waitFor(() => expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ userId: "user_1" }));
  });

  it("sends a typed reply with an Idempotency-Key while the window is open", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: /Asha Menon/ }));
    await user.type(await screen.findByRole("textbox", { name: "Reply to Asha Menon" }), "See you at 5{Enter}");
    await waitFor(() => expect(calls.some((call) => call.url.endsWith("/messages"))).toBe(true));
    const sent = calls.find((call) => call.url.endsWith("/messages"));
    expect(sent?.body).toEqual({ kind: "text", body: "See you at 5" });
    expect(sent?.headers["Idempotency-Key"]).toMatch(/^[A-Za-z0-9._:-]{8,160}$/);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Reply to Asha Menon" })).toHaveValue(""));
  });

  it("keeps Shift+Enter as a new line and shows the server's words when the window has closed", async () => {
    const user = userEvent.setup();
    routes["POST /api/staff/threads/thr_1/messages"] = () => new Response(JSON.stringify({ error: { code: "window_closed", message: "The 24-hour window has closed. Send an approved template." } }), { status: 409 });
    renderPanel();
    await user.click(await screen.findByRole("button", { name: /Asha Menon/ }));
    const box = await screen.findByRole("textbox", { name: "Reply to Asha Menon" });
    await user.type(box, "one{Shift>}{Enter}{/Shift}two");
    expect(box).toHaveValue("one\ntwo");
    expect(calls.some((call) => call.url.endsWith("/messages"))).toBe(false);
    await user.keyboard("{Enter}");
    expect(await screen.findByText("The 24-hour window has closed. Send an approved template.")).toBeInTheDocument();
  });

  it("offers approved templates, not a text box, once the window has closed, and sends one with the appointment", async () => {
    const user = userEvent.setup();
    routes["GET /api/staff/threads/thr_1"] = () => ok(detail({}, { windowOpen: false }));
    renderPanel();
    await user.click(await screen.findByRole("button", { name: /Asha Menon/ }));
    expect(await screen.findByText(/more than 24 hours since Asha Menon wrote, so WhatsApp only allows approved messages/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /Reply to/ })).toBeNull();
    await chooseOption(user, screen.getByRole("combobox", { name: "Approved message" }), "Booking confirmation");
    await user.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(calls.find((call) => call.url.endsWith("/messages"))?.body).toEqual({ kind: "template", templateKey: "booking_confirmed", appointmentId: "apt_9" }));
  });

  it("on a phone shows the list first, then the conversation with a Back button", async () => {
    device.mobile = true;
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: /Asha Menon/ }));
    expect(screen.queryByRole("list", { name: "Conversations" })).toBeNull();
    await screen.findByText("Sure, 5pm works");
    await user.click(screen.getByRole("button", { name: "Back to conversations" }));
    expect(await screen.findByRole("list", { name: "Conversations" })).toBeInTheDocument();
  });
});
