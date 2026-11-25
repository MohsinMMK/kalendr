/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { chooseOption, runBarAction } from "@/test/choose-option";
import type { PlatformRole } from "@/lib/admin-contracts";

import { BusinessDetail, messagesByChannel } from "./business-detail";
import { data, fail, health, mockFetch, Wrap } from "./test-support";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/admin" }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function open(role: PlatformRole, over: Record<string, unknown> = {}, onViewStarted = vi.fn()) {
  const calls = mockFetch((url, init) => {
    if (url === "/api/admin/tenants/tenant-0001" && !init?.method) return data(health(over));
    if (init?.method === "POST") return data({ ok: true, sessionId: "s1", endsAt: "2026-11-19T10:00:00.000Z", writeAccess: false });
    return fail(404, "not_found", "x");
  });
  render(<Wrap role={role}><BusinessDetail tenantId="tenant-0001" onViewStarted={onViewStarted} /></Wrap>);
  return { calls, onViewStarted };
}

describe("One business", () => {
  it("loads, then shows health, messages by channel, errors and own switches", async () => {
    open("support");
    expect(screen.getByRole("status", { name: "Loading business" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "City Clinic" })).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByText("WhatsApp")).toBeInTheDocument();
    expect(screen.getByText("3 failed")).toBeInTheDocument();
    expect(screen.getByText("whatsapp_template_rejected")).toBeInTheDocument();
    expect(screen.getByText("waitlist")).toBeInTheDocument();
    expect(screen.queryByText("Billing")).not.toBeInTheDocument();
  });

  it("shows the billing block when the business has one", async () => {
    open("billing", { billing: { planKey: "pro", status: "trialing", trialEndsAt: "2026-12-01T00:00:00.000Z", currentPeriodEnd: null, usage: { messages: 12 } } });
    expect(await screen.findByText("Billing")).toBeInTheDocument();
    expect(screen.getByText("Trialing")).toBeInTheDocument();
    expect(screen.getByText(/messages: 12/)).toBeInTheDocument();
  });

  it("offers a way to retry when it cannot load", async () => {
    let failing = true;
    mockFetch(() => failing ? fail(500, "internal", "Could not reach the database.") : data(health()));
    render(<Wrap><BusinessDetail tenantId="tenant-0001" /></Wrap>);
    expect(await screen.findByText("Could not reach the database.")).toBeInTheDocument();
    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "City Clinic" })).toBeInTheDocument();
  });

  it("shows a paused business as paused and offers Resume", async () => {
    open("support", { isActive: false, pausedAt: "2026-11-18T00:00:00.000Z" });
    expect(await screen.findByText(/Paused since/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("menuitem", { name: /Resume business/ })).toBeInTheDocument();
  });

  it("will not pause without a reason, then sends it with the reason", async () => {
    const { calls } = open("support");
    await screen.findByRole("heading", { name: "City Clinic" });
    await runBarAction(userEvent.setup(), /Pause business/);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Pause business" }));
    expect(await within(dialog).findByText(/Say why, in at least 5 characters/)).toBeInTheDocument();
    expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Owner asked us to stop bookings");
    await userEvent.click(within(dialog).getByRole("button", { name: "Pause business" }));
    await waitFor(() => expect(calls.find((call) => call.init?.method === "POST")?.url).toBe("/api/admin/tenants/tenant-0001/pause"));
    expect(JSON.parse(String(calls.find((call) => call.init?.method === "POST")?.init?.body))).toEqual({ paused: true, reason: "Owner asked us to stop bookings" });
  });

  it("View as asks for 10 characters, hides write for support, and starts the session", async () => {
    const { calls, onViewStarted } = open("support");
    await screen.findByRole("heading", { name: "City Clinic" });
    await runBarAction(userEvent.setup(), /View as this business/);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("switch", { name: "Allow changes" })).not.toBeInTheDocument();
    expect(within(dialog).getByText(/30 minutes/)).toBeInTheDocument();
    expect(within(dialog).getByText(/read-only/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Why do you need to look?"), "too short");
    await userEvent.click(within(dialog).getByRole("button", { name: "Start viewing" }));
    expect(await within(dialog).findByText(/at least 10 characters/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Why do you need to look?"), " owner reports missed reminders");
    await userEvent.click(within(dialog).getByRole("button", { name: "Start viewing" }));
    await waitFor(() => expect(onViewStarted).toHaveBeenCalled());
    const post = calls.find((call) => call.url.endsWith("/impersonate"));
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({ write: false });
  });

  it("View as shows the write switch to a super admin only", async () => {
    open("super");
    await screen.findByRole("heading", { name: "City Clinic" });
    await runBarAction(userEvent.setup(), /View as this business/);
    expect(await screen.findByRole("switch", { name: "Allow changes" })).toBeInTheDocument();
  });

  it("billing role is read only: no actions beyond the audit trail", async () => {
    open("billing");
    await screen.findByRole("heading", { name: "City Clinic" });
    expect(screen.queryByRole("button", { name: /View as this business|Pause business|Resend/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Audit trail" })).toBeInTheDocument();
  });
});

describe("messagesByChannel", () => {
  it("groups channel:status keys", () => {
    expect(messagesByChannel({ "sms:sent": 2, "sms:failed": 1, "email:delivered": 5 })).toEqual([
      { channel: "sms", total: 3, statuses: [["sent", 2], ["failed", 1]] },
      { channel: "email", total: 5, statuses: [["delivered", 5]] },
    ]);
  });
});

describe("Billing actions", () => {
  const trialing = { billing: { planKey: "growth", status: "trialing", trialEndsAt: "2026-12-01T00:00:00.000Z", currentPeriodEnd: null, usage: {} } };

  it.each(["support"] as PlatformRole[])("are not offered to %s", async (role) => {
    open(role, trialing);
    await screen.findByRole("heading", { name: "City Clinic" });
    expect(screen.queryByText("Billing actions")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Extend trial|Change plan/ })).not.toBeInTheDocument();
  });

  it.each(["billing", "super"] as PlatformRole[])("are offered to %s", async (role) => {
    open(role, trialing);
    await screen.findByRole("heading", { name: "City Clinic" });
    expect(screen.getByText("Billing actions")).toBeInTheDocument();
    await runBarAction(userEvent.setup(), /Extend trial/);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("extends a trial with days and a reason", async () => {
    const { calls } = open("billing", trialing);
    await screen.findByRole("heading", { name: "City Clinic" });
    await runBarAction(userEvent.setup(), /Extend trial/);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Extend trial" }));
    expect(await within(dialog).findByText(/Say why, in at least 5 characters/)).toBeInTheDocument();
    expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
    await userEvent.clear(within(dialog).getByLabelText("Days"));
    await userEvent.type(within(dialog).getByLabelText("Days"), "14");
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Owner lost a week to an outage");
    await userEvent.click(within(dialog).getByRole("button", { name: "Extend trial" }));
    await waitFor(() => expect(calls.find((call) => call.init?.method === "POST")?.url).toBe("/api/admin/tenants/tenant-0001/extend-trial"));
    expect(JSON.parse(String(calls.find((call) => call.init?.method === "POST")?.init?.body))).toEqual({ days: 14, reason: "Owner lost a week to an outage" });
  });

  it("changes the plan with a plan choice and a reason", async () => {
    const { calls } = open("super", trialing);
    await screen.findByRole("heading", { name: "City Clinic" });
    await runBarAction(userEvent.setup(), /Change plan/);
    const dialog = await screen.findByRole("dialog");
    await chooseOption(userEvent.setup(), within(dialog).getByRole("combobox"), "Scale");
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Paid by bank transfer, invoice 1042");
    await userEvent.click(within(dialog).getByRole("button", { name: "Change plan" }));
    await waitFor(() => expect(calls.find((call) => call.init?.method === "POST")?.url).toBe("/api/admin/tenants/tenant-0001/change-plan"));
    expect(JSON.parse(String(calls.find((call) => call.init?.method === "POST")?.init?.body))).toEqual({ planKey: "scale", reason: "Paid by bank transfer, invoice 1042" });
  });
});
