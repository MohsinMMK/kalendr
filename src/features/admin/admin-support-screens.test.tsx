/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { chooseOption } from "@/test/choose-option";
import type { PlatformRole } from "@/lib/admin-contracts";

import { AbuseScreen } from "./abuse-screen";
import { AuditScreen } from "./audit-screen";
import { humaniseAction } from "./admin-format";
import { FeaturesScreen } from "./features-screen";
import { MessagesScreen } from "./messages-screen";
import { OperatorsScreen } from "./operators-screen";
import { data, fail, mockFetch, Wrap } from "./test-support";
import { WorkerScreen } from "./worker-screen";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const message = {
  notificationId: "notif-0001", tenantId: "tenant-0001", appointmentId: "appt-0001", channel: "whatsapp", templateKey: "reminder_24h", status: "failed", attemptCount: 3,
  scheduledAt: "2026-11-18T08:00:00.000Z", sentAt: "2026-11-18T08:01:00.000Z", deliveredAt: null, failedAt: "2026-11-18T08:05:00.000Z", failureCode: "131026", costCategory: null, hasProviderId: true,
  explanation: "WhatsApp could not deliver it: the number is not on WhatsApp. It was tried 3 times.",
  outbox: [{ eventId: "evt-00000001", eventType: "notification.send", status: "dead_letter", attemptCount: 3, lastErrorCode: "131026", availableAt: "2026-11-18T08:05:00.000Z" }],
};

describe("Messages", () => {
  it("starts with a prompt, shows the explanation first, then the timeline and attempts", async () => {
    const calls = mockFetch(() => data([message]));
    render(<Wrap><MessagesScreen /></Wrap>);
    expect(screen.getByText("Search for a message")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Message id or appointment id" }), "appt-0001");
    await userEvent.click(screen.getByRole("button", { name: "Find" }));
    const reason = await screen.findByText(/number is not on WhatsApp/);
    expect(reason.closest("div")?.textContent).toContain("Why");
    expect(calls[0].url).toBe("/api/admin/messages?id=appt-0001");
    expect(screen.getByRole("list", { name: "Message timeline" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Delivery attempts" })).getByText("131026")).toBeInTheDocument();
    expect(screen.getByText("3 attempts")).toBeInTheDocument();
  });
  it("says when nothing matches, and when the id is too short", async () => {
    mockFetch(() => data([]));
    render(<Wrap><MessagesScreen /></Wrap>);
    const box = screen.getByRole("textbox", { name: "Message id or appointment id" });
    await userEvent.type(box, "abc");
    await userEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/at least 8 characters/);
    await userEvent.clear(box);
    await userEvent.type(box, "nothing-here");
    await userEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(await screen.findByText("No message found")).toBeInTheDocument();
  });
  it("tells a billing operator the lookup is for support, without calling the API", () => {
    const calls = mockFetch(() => data([message]));
    render(<Wrap role="billing"><MessagesScreen /></Wrap>);
    expect(screen.getByText("Support and super admins only")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
  it("shows an error with retry", async () => {
    let failing = true;
    mockFetch(() => failing ? fail(500, "internal", "Search is down.") : data([message]));
    render(<Wrap><MessagesScreen /></Wrap>);
    await userEvent.type(screen.getByRole("textbox", { name: "Message id or appointment id" }), "notif-0001");
    await userEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(await screen.findByText("Search is down.")).toBeInTheDocument();
    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/number is not on WhatsApp/)).toBeInTheDocument();
  });
});

const now = Date.now();
const worker = {
  pending: 12, oldestPendingSeconds: 400, deadLetters: 1,
  heartbeats: [
    { workerId: "worker-aaaaaaaa", mode: "all", version: "1.2.0", lastSeenAt: new Date(now - 5_000).toISOString(), stoppedAt: null },
    { workerId: "worker-bbbbbbbb", mode: "all", version: "1.1.0", lastSeenAt: new Date(now - 300_000).toISOString(), stoppedAt: null },
  ],
  deadLetterItems: [{ eventId: "evt-dead-0001", tenantId: "tenant-0001", eventType: "notification.send", attempts: 8, lastErrorCode: "provider_timeout", createdAt: "2026-11-18T00:00:00.000Z" }],
};

describe("Worker", () => {
  it("shows queue depth, flags a stale worker in words, and lists dead letters", async () => {
    mockFetch(() => data(worker));
    render(<Wrap><WorkerScreen /></Wrap>);
    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText(/Stale: no check-in for 5 min/)).toBeInTheDocument();
    expect(screen.getByText(/Updated/)).toHaveTextContent(/every 15 seconds/);
    expect(screen.getByText("provider_timeout")).toBeInTheDocument();
  });
  it("retry needs a reason, then posts it", async () => {
    const calls = mockFetch((url, init) => init?.method === "POST" ? data({ ok: true }) : data(worker));
    render(<Wrap><WorkerScreen /></Wrap>);
    await userEvent.click(await screen.findByRole("button", { name: /Retry event/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry job" }));
    expect(await within(dialog).findByText(/Say why/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Provider outage is over");
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry job" }));
    await waitFor(() => expect(calls.find((call) => call.init?.method === "POST")?.url).toBe("/api/admin/worker/retry"));
    expect(JSON.parse(String(calls.find((call) => call.init?.method === "POST")?.init?.body))).toEqual({ eventId: "evt-dead-0001", reason: "Provider outage is over" });
  });
  it("empty: no workers and no dead letters, with plain words", async () => {
    mockFetch(() => data({ pending: 0, oldestPendingSeconds: 0, deadLetters: 0, heartbeats: [], deadLetterItems: [] }));
    render(<Wrap><WorkerScreen /></Wrap>);
    expect(await screen.findByText("No worker has checked in")).toBeInTheDocument();
    expect(screen.getByText("No dead letters")).toBeInTheDocument();
  });
  it("error with retry", async () => {
    mockFetch(() => fail(503, "unavailable", "Worker data is unavailable."));
    render(<Wrap><WorkerScreen /></Wrap>);
    expect(await screen.findByText("Worker data is unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
  it("hides Retry from a role that cannot retry", async () => {
    mockFetch(() => data(worker));
    render(<Wrap role="billing"><WorkerScreen /></Wrap>);
    await screen.findByText("provider_timeout");
    expect(screen.queryByRole("button", { name: /Retry event/ })).not.toBeInTheDocument();
  });
});

describe("Abuse", () => {
  it("lists high-volume and suppression counts and new sign-ups", async () => {
    mockFetch(() => data({ highVolume: [{ tenantId: "tenant-0001", name: "Loud Salon", messages24h: 900 }], suppressions: [{ tenantId: "tenant-0002", name: "Quiet Clinic", count: 14 }], newBusinesses24h: 7 }));
    render(<Wrap><AbuseScreen /></Wrap>);
    expect(await screen.findByText("Loud Salon")).toBeInTheDocument();
    expect(screen.getByText("900 messages")).toBeInTheDocument();
    expect(screen.getByText("14 suppressed")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });
  it("nothing unusual is an empty state", async () => {
    mockFetch(() => data({ highVolume: [], suppressions: [], newBusinesses24h: 0 }));
    render(<Wrap><AbuseScreen /></Wrap>);
    expect((await screen.findAllByText("Nothing unusual")).length).toBe(2);
  });
});

const rollout = { featureKey: "waitlist.v2", mode: "percent", percent: 25, tenantIds: [], updatedAt: "2026-11-18T00:00:00.000Z" };

describe("Features", () => {
  it("lists rollouts and lets a super admin edit with a reason", async () => {
    const calls = mockFetch((url, init) => init?.method === "PUT" ? data([rollout]) : data([rollout]));
    render(<Wrap role="super"><FeaturesScreen /></Wrap>);
    expect(await screen.findByText("On for 25% of businesses")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit waitlist.v2" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("combobox"));
    await userEvent.click(await screen.findByRole("option", { name: "On for listed businesses" }));
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Try it with two clinics");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save rollout" }));
    expect(await within(dialog).findByText("List at least one business id.")).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Business ids"), "tenant-0001{enter}tenant-0002");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save rollout" }));
    await waitFor(() => expect(calls.find((call) => call.init?.method === "PUT")).toBeTruthy());
    expect(JSON.parse(String(calls.find((call) => call.init?.method === "PUT")?.init?.body))).toEqual({ featureKey: "waitlist.v2", mode: "listed", percent: 0, tenantIds: ["tenant-0001", "tenant-0002"], reason: "Try it with two clinics" });
  });
  it("is read only for support", async () => {
    mockFetch(() => data([rollout]));
    render(<Wrap role="support"><FeaturesScreen /></Wrap>);
    expect(await screen.findByText("On for 25% of businesses")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit|New rollout/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Only a super admin can change rollouts/)).toBeInTheDocument();
  });
  it("empty and error states", async () => {
    mockFetch(() => data([]));
    render(<Wrap role="super"><FeaturesScreen /></Wrap>);
    expect(await screen.findByText("No rollouts yet")).toBeInTheDocument();
    cleanup();
    mockFetch(() => fail(500, "internal", "Rollouts did not load."));
    render(<Wrap role="super"><FeaturesScreen /></Wrap>);
    expect(await screen.findByText("Rollouts did not load.")).toBeInTheDocument();
  });
});

describe("Audit", () => {
  const rows = [{ id: "a1", adminUserId: "operator-0001", tenantId: "tenant-0001", action: "tenant.verification_resent", reason: "Owner never got the email", metadata: {}, occurredAt: "2026-11-18T08:00:00.000Z" }];
  it("humanises actions and filters by business", async () => {
    const calls = mockFetch(() => data(rows));
    render(<Wrap><AuditScreen initialTenant="tenant-0001" /></Wrap>);
    expect((await screen.findAllByText("Resent a verification email")).length).toBeGreaterThan(0);
    expect(calls[0].url).toBe("/api/admin/audit?tenantId=tenant-0001");
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(calls.at(-1)?.url).toBe("/api/admin/audit"));
  });
  it("empty and error", async () => {
    mockFetch(() => data([]));
    render(<Wrap><AuditScreen /></Wrap>);
    expect(await screen.findByText("Nothing recorded")).toBeInTheDocument();
    cleanup();
    mockFetch(() => fail(500, "internal", "Audit failed."));
    render(<Wrap><AuditScreen /></Wrap>);
    expect(await screen.findByText("Audit failed.")).toBeInTheDocument();
  });
  it("humanises unknown codes without hiding them", () => {
    expect(humaniseAction("thing.did_something")).toBe("Thing did something");
  });
});

describe("Operators", () => {
  const list = [{ userId: "user-00000001", role: "super", isActive: true, createdAt: "2026-10-01T00:00:00.000Z" }];
  function renderAs(role: PlatformRole) { render(<Wrap role={role}><OperatorsScreen /></Wrap>); }
  it("is for super admins only", () => {
    mockFetch(() => data(list));
    renderAs("support");
    expect(screen.getByText("Super admins only")).toBeInTheDocument();
  });
  it("lists operators and adds one", async () => {
    const calls = mockFetch((url, init) => init?.method === "PUT" ? data(list) : data(list));
    renderAs("super");
    expect(await screen.findByText("Super admin")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add or change operator" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Sign-in email"), "not-an-email");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save operator" }));
    expect(await within(dialog).findByText("Enter a valid email address.")).toBeInTheDocument();
    await userEvent.clear(within(dialog).getByLabelText("Sign-in email"));
    await userEvent.type(within(dialog).getByLabelText("Sign-in email"), "New.Person@example.com");
    await chooseOption(userEvent.setup(), within(dialog).getByRole("combobox"), "Billing");
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Joins the finance team");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save operator" }));
    await waitFor(() => expect(calls.find((call) => call.init?.method === "PUT")).toBeTruthy());
    expect(JSON.parse(String(calls.find((call) => call.init?.method === "PUT")?.init?.body))).toEqual({ email: "new.person@example.com", role: "billing", active: true, reason: "Joins the finance team" });
  });
  it("asks for the code when the server wants a fresh one", async () => {
    // Without the step-up provider a refusal reaches the dialog as a readable sentence.
    mockFetch((url, init) => init?.method === "PUT" ? fail(403, "step_up_required", "Enter a fresh code.") : data(list));
    renderAs("super");
    await userEvent.click(await screen.findByRole("button", { name: "Add or change operator" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Sign-in email"), "a@example.com");
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Joins the team");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save operator" }));
    expect(await within(dialog).findByText(/fresh authenticator code/)).toBeInTheDocument();
  });
  it("empty and error", async () => {
    mockFetch(() => data([]));
    renderAs("super");
    expect(await screen.findByText("No operators")).toBeInTheDocument();
    cleanup();
    mockFetch(() => fail(500, "internal", "Operators did not load."));
    renderAs("super");
    expect(await screen.findByText("Operators did not load.")).toBeInTheDocument();
  });
});
