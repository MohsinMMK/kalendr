/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { PortalPrivacy } from "./privacy-client";
import { PortalPrivacyWorkspace } from "./privacy-workspace";

const replace = vi.fn();
const router = { replace, push: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const notice = {
  version: "2026-11",
  language: "en",
  title: "How we use your information",
  isDefault: true,
  purposes: {
    appointment_messages: { label: "Appointment messages", text: "Confirmations and reminders." },
    marketing_messages: { label: "News and offers", text: "Offers, only if you say yes." },
    reviews: { label: "Review requests", text: "A message after your visit." },
    records_sharing: { label: "Sharing records with you", text: "Documents in your portal." },
  },
  paragraphs: ["We keep your details to run your bookings."],
};

function person(over: Partial<PortalPrivacy["people"][number]> = {}): PortalPrivacy["people"][number] {
  return {
    clinicSlug: "lotus", clinicName: "Lotus Dental", patientId: "p1", name: "Asha Rao", isMinor: false, guardianOnFile: false,
    consents: [
      { purpose: "appointment_messages", granted: true, answered: false, wordingVersion: null, since: null },
      { purpose: "marketing_messages", granted: false, answered: false, wordingVersion: null, since: null },
      { purpose: "reviews", granted: true, answered: false, wordingVersion: null, since: null },
      { purpose: "records_sharing", granted: true, answered: false, wordingVersion: null, since: null },
    ],
    requests: [],
    ...over,
  } as PortalPrivacy["people"][number];
}

function payload(people: PortalPrivacy["people"]): { data: PortalPrivacy } {
  return { data: { noticeVersion: "2026-11", people, notices: { lotus: notice } } as PortalPrivacy };
}

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

function mockFetch(handler: Handler) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const result = await handler(url, init);
    const status = result.status ?? 200;
    return { ok: status < 400, status, json: async () => result.body } as Response;
  }));
  return calls;
}

const error = (code: string, message: string) => ({ error: { code, message } });

beforeEach(() => { window.sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); replace.mockClear(); });

describe("portal privacy page", () => {
  it("shows one switch per purpose, marketing off, and withdraws in a single click", async () => {
    const user = userEvent.setup();
    const calls = mockFetch((url, init) => {
      if (url.startsWith("/api/portal/privacy/consents")) return { body: { data: { consents: [], changed: true } } };
      expect(init?.method ?? "GET").toBe("GET");
      return { body: payload([person()]) };
    });
    render(<PortalPrivacyWorkspace />);
    expect(await screen.findByRole("heading", { name: "Your privacy" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Appointment messages" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Marketing messages" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Reviews" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Sharing my records" })).toBeChecked();
    await user.click(screen.getByRole("switch", { name: "Reviews" }));
    const put = calls.find((call) => call.url === "/api/portal/privacy/consents");
    expect(put?.init?.method).toBe("PUT");
    expect(JSON.parse(String(put?.init?.body))).toEqual({ clinicSlug: "lotus", patientId: "p1", purpose: "reviews", granted: false, wordingVersion: "2026-11" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("puts the switch back and says why when saving fails", async () => {
    const user = userEvent.setup();
    mockFetch((url) => url.includes("/consents") ? { status: 500, body: error("internal_error", "That choice could not be saved.") } : { body: payload([person()]) });
    render(<PortalPrivacyWorkspace />);
    await user.click(await screen.findByRole("switch", { name: "Reviews" }));
    expect(await screen.findByText("That choice could not be saved.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Reviews" })).toBeChecked();
  });

  it("explains that a guardian is needed for someone under 18 and never offers marketing", async () => {
    const user = userEvent.setup();
    const calls = mockFetch((url, init) => {
      if (url.includes("/consents") && !JSON.parse(String(init?.body)).guardian) return { status: 409, body: error("guardian_required", "A guardian is needed.") };
      if (url.includes("/consents")) return { body: { data: { consents: [], changed: true } } };
      return { body: payload([person({ name: "Kabir Rao", isMinor: true })]) };
    });
    render(<PortalPrivacyWorkspace />);
    expect(await screen.findByText("A parent or guardian needs to choose for Kabir Rao")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Marketing messages" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("We never send marketing to anyone under 18.")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Appointment messages" }));
    const dialog = await screen.findByRole("dialog", { name: "Who is the parent or guardian?" });
    await user.type(within(dialog).getByLabelText("Their name"), "Meera Rao");
    await user.click(within(dialog).getByRole("combobox", { name: "How are they related?" }));
    await user.click(await screen.findByRole("option", { name: "Mother" }));
    await user.type(within(dialog).getByLabelText("Their email or phone number"), "meera@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(calls.filter((call) => call.url.includes("/consents"))).toHaveLength(2));
    const second = JSON.parse(String(calls.filter((call) => call.url.includes("/consents"))[1]?.init?.body));
    expect(second.guardian).toEqual({ name: "Meera Rao", relationship: "mother", contact: "meera@example.com" });
  });

  it("asks for a download and tells the person what happens next", async () => {
    const user = userEvent.setup();
    const calls = mockFetch((url) => {
      if (url === "/api/portal/privacy/requests") return { status: 201, body: { data: { request: {}, created: true } } };
      return { body: payload([person()]) };
    });
    render(<PortalPrivacyWorkspace />);
    await user.click(await screen.findByRole("button", { name: "Download my data" }));
    const post = calls.find((call) => call.url === "/api/portal/privacy/requests");
    expect(JSON.parse(String(post?.init?.body))).toEqual({ clinicSlug: "lotus", patientId: "p1", type: "export" });
    expect(await screen.findByText(/We are preparing your download/)).toBeInTheDocument();
  });

  it("needs a recent sign-in code for a download and sends the person through sign-in", async () => {
    const user = userEvent.setup();
    mockFetch((url) => {
      if (url === "/api/portal/privacy/requests") return { status: 403, body: error("fresh_code_required", "Enter a new code.") };
      if (url === "/api/portal/auth/sign-out") return { body: { data: { signedOut: true } } };
      return { body: payload([person()]) };
    });
    render(<PortalPrivacyWorkspace />);
    await user.click(await screen.findByRole("button", { name: "Download my data" }));
    const dialog = await screen.findByRole("dialog", { name: "We need a new sign-in code" });
    expect(JSON.parse(window.sessionStorage.getItem("kalendr-privacy-pending-v1") ?? "{}")).toMatchObject({ type: "export", patientId: "p1" });
    await user.click(within(dialog).getByRole("button", { name: "Get a new code" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/portal/sign-in?next=privacy"));
  });

  it("sends a correction with the note the person wrote", async () => {
    const user = userEvent.setup();
    const calls = mockFetch((url) => url === "/api/portal/privacy/requests" ? { status: 201, body: { data: { request: {}, created: true } } } : { body: payload([person()]) });
    render(<PortalPrivacyWorkspace />);
    await user.click(await screen.findByRole("button", { name: "Ask for a correction" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask for a correction" });
    await user.click(within(dialog).getByRole("button", { name: "Send request" }));
    expect(await screen.findByText("Tell us what needs to change.")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "My surname is Rau.");
    await user.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/portal/privacy/requests")).toBe(true));
    expect(JSON.parse(String(calls.find((call) => call.url === "/api/portal/privacy/requests")?.init?.body))).toMatchObject({ type: "correction", note: "My surname is Rau." });
  });

  it("lists requests with their result, including what an erasure removed and kept", async () => {
    const base = { createdAt: "2026-11-01T00:00:00Z", dueAt: "2027-01-30T00:00:00Z", daysRemaining: null, overdue: false, decisionNote: null, decidedAt: null, version: 3 };
    mockFetch(() => ({
      body: payload([person({
        requests: [
          { ...base, id: "r1", type: "export", status: "completed", decisionReason: "verified", completedAt: new Date().toISOString(), summary: null },
          { ...base, id: "r2", type: "erasure", status: "completed", decisionReason: "verified", completedAt: "2026-11-10T00:00:00Z", summary: { removed: ["Your name and phone number"], kept: ["Payments, kept for 8 years"] } },
          { ...base, id: "r3", type: "correction", status: "refused", decisionReason: "identity_not_confirmed", completedAt: null, summary: null },
          { ...base, id: "r4", type: "export", status: "requested", decisionReason: null, daysRemaining: -2, overdue: true, completedAt: null, summary: null },
        ],
      })]),
    }));
    render(<PortalPrivacyWorkspace />);
    expect(await screen.findByText("Your download is ready. We emailed the link. It works once, for 7 days.")).toBeInTheDocument();
    expect(screen.getByText("Your name and phone number")).toBeInTheDocument();
    expect(screen.getByText("Payments, kept for 8 years")).toBeInTheDocument();
    expect(screen.getByText(/We could not confirm it is you/)).toBeInTheDocument();
    expect(screen.getByText(/This is taking longer than we promised/)).toBeInTheDocument();
    expect(screen.getByText("Notice version 2026-11.", { exact: false })).toBeInTheDocument();
  });

  it("shows a retry when the page cannot load, and an empty state when nothing is held", async () => {
    const user = userEvent.setup();
    let fail = true;
    mockFetch(() => fail ? { status: 500, body: error("internal_error", "Something broke.") } : { body: payload([]) });
    render(<PortalPrivacyWorkspace />);
    expect(await screen.findByText("We could not load this page")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("We do not hold any details about you")).toBeInTheDocument();
  });

  it("never says the product is compliant", async () => {
    mockFetch(() => ({ body: payload([person()]) }));
    const view = render(<PortalPrivacyWorkspace />);
    await screen.findByRole("heading", { name: "Your privacy" });
    expect(view.container.textContent ?? "").not.toMatch(/compliant/i);
  });
});
