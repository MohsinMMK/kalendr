/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { campaignPresets, type AudiencePreview, type CampaignSummary } from "@/lib/campaign-contracts";
import { permissionKeys, type Permission } from "@/lib/permissions";
import { chooseOption, runBarAction } from "@/test/choose-option";
import { failure, installFetch, json, stubKeys } from "@/test/offers-fixtures";
import { TestQueryProvider } from "@/test/query-wrapper";

let search = "";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(search) }));

import { CampaignsWorkspace } from "./campaigns-workspace";
import { StaffAccessProvider } from "./staff-access";
import { StaffSnapshotProvider } from "./staff-snapshot-provider";

const stats = { planned: 12, sent: 10, delivered: 9, failed: 0, skipped: 2, booked: 3, unsubscribed: 1, revenueMinor: 450000, currency: "INR" };
const campaign = (patch: Partial<CampaignSummary> = {}): CampaignSummary => ({
  id: "c1", name: "6-month recall", kind: "automated", ruleType: "recall", presetKey: "recall", channel: "email", status: "active", pausedReason: null, segmentId: null, segmentName: null,
  rule: { type: "recall", services: [{ serviceId: "service_cleaning", intervalDays: 180 }] }, subject: "Time for your check-up?", body: "Hi {customer_first_name}", templateKey: null, serviceId: null,
  scheduledAt: null, code: "cabc", version: 3, tested: false, stats, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z", ...patch,
});
const audience: AudiencePreview = {
  matching: 10, eligible: 6,
  leftOut: [{ reason: "no_marketing_consent", label: "Have not agreed to marketing messages", count: 3 }, { reason: "future_booking", label: "Already have a booking coming up", count: 1 }],
  cost: null,
};
const options = () => json({
  presets: campaignPresets("dental"),
  templates: [{ key: "campaign_recall", label: "Time for your next visit", approved: false }],
  channels: [{ channel: "email", ready: true, reason: "" }, { channel: "whatsapp", ready: false, reason: "WhatsApp isn't connected yet." }, { channel: "sms", ready: false, reason: "Text messages aren't connected yet." }],
});

function renderWorkspace({ permissions = permissionKeys, database = true }: { permissions?: readonly Permission[]; database?: boolean } = {}) {
  const inner = <StaffAccessProvider role="owner" permissions={permissions} userId={null}><CampaignsWorkspace /></StaffAccessProvider>;
  return render(<TestQueryProvider>{database ? <StaffSnapshotProvider role="owner">{inner}</StaffSnapshotProvider> : inner}</TestQueryProvider>);
}

beforeEach(() => { stubKeys(); search = ""; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("campaigns workspace", () => {
  it("shows loading, then each campaign with its numbers, and the ready-made ones switched off", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    installFetch((_r, url) => {
      if (url.pathname === "/api/staff/campaigns") return held.then(() => json([campaign()]));
      if (url.pathname === "/api/staff/campaigns/options") return options();
      return undefined;
    });
    renderWorkspace();
    expect(await screen.findByRole("status", { name: "Loading campaigns" })).toBeInTheDocument();
    release();
    const list = await screen.findByRole("list", { name: "Campaigns" });
    expect(within(list).getByText("6-month recall")).toBeInTheDocument();
    expect(within(list).getByText("10 sent")).toBeInTheDocument();
    expect(within(list).getByText("3 booked")).toBeInTheDocument();
    expect(within(list).getByText("₹4,500")).toBeInTheDocument();
    expect(within(list).getByText("1 unsubscribed")).toBeInTheDocument();
    const presets = await screen.findByRole("list", { name: "Ready-made campaigns" });
    expect(within(presets).getByText("Birthday greeting")).toBeInTheDocument();
    expect(within(presets).getAllByText("Off").length).toBeGreaterThan(0);
    expect(within(presets).getByText("On")).toBeInTheDocument();
  });

  it("explains an empty list, shows an error with a retry, and sends nothing in the preview", async () => {
    const user = userEvent.setup();
    let calls = 0;
    installFetch((_r, url) => {
      if (url.pathname === "/api/staff/campaigns") return ++calls === 1 ? failure(500, "boom", "Campaigns are down.") : json([]);
      if (url.pathname === "/api/staff/campaigns/options") return options();
      return undefined;
    });
    renderWorkspace();
    expect(await screen.findByText("Campaigns are down.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No campaigns yet")).toBeInTheDocument();
    cleanup();
    const requests = installFetch(() => undefined);
    renderWorkspace({ database: false });
    expect(screen.getByText("Campaigns are not available in the preview")).toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it("turns on a birthday greeting in one click, with an Idempotency-Key and no questions", async () => {
    const user = userEvent.setup();
    const requests = installFetch((request, url) => {
      if (url.pathname === "/api/staff/campaigns/presets/birthday" && request.method === "POST") return json(campaign({ id: "c2", name: "Birthday greeting", presetKey: "birthday" }), 201);
      if (url.pathname === "/api/staff/campaigns") return json([]);
      if (url.pathname === "/api/staff/campaigns/options") return options();
      return undefined;
    });
    renderWorkspace();
    await user.click(await screen.findByRole("button", { name: "Turn on Birthday greeting" }));
    await waitFor(() => expect(requests.some((request) => request.method === "POST")).toBe(true));
    const post = requests.find((request) => request.method === "POST")!;
    expect(post.body).toEqual({ channel: "email", templateKey: null });
    expect(post.headers["Idempotency-Key"]).toMatch(/^key-\d+$/);
    expect(screen.queryByRole("dialog", { name: /Turn on/ })).not.toBeInTheDocument();
  });

  it("asks which service and how long after for a recall, and refuses to go on without one", async () => {
    const user = userEvent.setup();
    const requests = installFetch((request, url) => {
      if (url.pathname === "/api/staff/campaigns/presets/recall" && request.method === "POST") return json(campaign(), 201);
      if (url.pathname === "/api/staff/campaigns") return json([]);
      if (url.pathname === "/api/staff/campaigns/options") return options();
      return undefined;
    });
    renderWorkspace();
    await user.click(await screen.findByRole("button", { name: /Turn on 6-month recall/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Turn on" }));
    expect(await within(dialog).findByText(/and a number of days/)).toBeInTheDocument();
    expect(requests.some((request) => request.method === "POST")).toBe(false);
    await chooseOption(user, within(dialog).getByRole("combobox", { name: / 1$/ }), "Routine cleaning");
    await user.click(within(dialog).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(requests.some((request) => request.method === "POST")).toBe(true));
    expect(requests.find((request) => request.method === "POST")!.body).toEqual({ channel: "email", templateKey: null, recallServices: [{ serviceId: "service_cleaning", intervalDays: 180 }] });
  });

  it("opens a campaign from the address and shows who it reaches and who was left out, and why", async () => {
    search = "campaign=c1";
    installFetch((_r, url) => {
      if (url.pathname === "/api/staff/campaigns") return json([campaign()]);
      if (url.pathname === "/api/staff/campaigns/options") return options();
      if (url.pathname === "/api/staff/campaigns/c1/audience") return json(audience);
      if (url.pathname === "/api/staff/campaigns/c1/preview") return json({ customerFirstName: "Asha", subject: "Time for your check-up?", body: "Hi Asha", template: null, bookLink: "https://x.example/book/a" });
      return undefined;
    });
    renderWorkspace();
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByText(/Reaches 6 /)).toBeInTheDocument();
    expect(within(sheet).getByText("Have not agreed to marketing messages")).toBeInTheDocument();
    expect(within(sheet).getByText("Already have a booking coming up")).toBeInTheDocument();
    expect(await within(sheet).findByText("Only staff see this")).toBeInTheDocument();
    expect(within(sheet).getByText("Filled in for Asha.")).toBeInTheDocument();
  });

  it("says a test is needed when a one-off is turned on without one, and links nowhere it should not", async () => {
    search = "campaign=c9";
    const user = userEvent.setup();
    installFetch((request, url) => {
      if (url.pathname === "/api/staff/campaigns") return json([campaign({ id: "c9", kind: "one_off", ruleType: null, rule: null, presetKey: null, status: "draft", segmentName: "Regulars", version: 1 })]);
      if (url.pathname === "/api/staff/campaigns/options") return options();
      if (url.pathname.endsWith("/audience")) return json(audience);
      if (url.pathname.endsWith("/preview")) return json({ customerFirstName: "Asha", subject: "", body: "", template: null, bookLink: "https://x" });
      if (url.pathname === "/api/staff/campaigns/c9/status") return failure(409, "test_required", "Send yourself a test first. It checks how the message looks before it goes to everyone.");
      return undefined;
    });
    renderWorkspace();
    await screen.findByRole("dialog");
    await runBarAction(user, "Turn on");
    expect(await screen.findByText(/Send yourself a test first/)).toBeInTheDocument();
    expect(screen.getByText(/Send yourself a test before this goes to everyone/)).toBeInTheDocument();
  });

  it("pauses a running campaign and resumes a paused one, carrying the version it saw", async () => {
    search = "campaign=c1";
    const user = userEvent.setup();
    let current = campaign({ version: 3 });
    const requests = installFetch((request, url) => {
      if (url.pathname === "/api/staff/campaigns") return json([current]);
      if (url.pathname === "/api/staff/campaigns/options") return options();
      if (url.pathname.endsWith("/audience")) return json(audience);
      if (url.pathname.endsWith("/preview")) return json({ customerFirstName: "Asha", subject: "", body: "", template: null, bookLink: "https://x" });
      if (url.pathname === "/api/staff/campaigns/c1/status") {
        const action = (request.body as { action: string }).action;
        current = campaign({ version: 4, status: action === "pause" ? "paused" : "active", pausedReason: null });
        return json(current);
      }
      return undefined;
    });
    renderWorkspace();
    await screen.findByRole("dialog");
    await runBarAction(user, "Pause");
    await waitFor(() => expect(requests.find((request) => request.url.endsWith("/status"))?.body).toEqual({ action: "pause", version: 3 }));
    expect((await screen.findAllByText("Paused")).length).toBeGreaterThan(0);
    await runBarAction(user, "Resume");
    await waitFor(() => expect(requests.filter((request) => request.url.endsWith("/status"))).toHaveLength(2));
    expect(requests.filter((request) => request.url.endsWith("/status"))[1]!.body).toEqual({ action: "resume", version: 4 });
  });

  it("tells the owner why a campaign paused itself", async () => {
    search = "campaign=c1";
    installFetch((_r, url) => {
      if (url.pathname === "/api/staff/campaigns") return json([campaign({ status: "paused", pausedReason: "high_unsubscribes" })]);
      if (url.pathname === "/api/staff/campaigns/options") return options();
      if (url.pathname.endsWith("/audience")) return json(audience);
      if (url.pathname.endsWith("/preview")) return json({ customerFirstName: "Asha", subject: "", body: "", template: null, bookLink: "https://x" });
      return undefined;
    });
    renderWorkspace();
    expect(await screen.findByText(/More people than usual unsubscribed/)).toBeInTheDocument();
  });

  it("hides the new-campaign and turn-on actions from someone without the campaigns permission", async () => {
    installFetch((_r, url) => (url.pathname === "/api/staff/campaigns" ? json([campaign()]) : url.pathname === "/api/staff/campaigns/options" ? options() : undefined));
    renderWorkspace({ permissions: ["schedule.read"] });
    await screen.findByRole("list", { name: "Campaigns" });
    expect(screen.queryByRole("button", { name: /New campaign/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Turn on 6-month recall/ })).not.toBeInTheDocument();
  });
});
