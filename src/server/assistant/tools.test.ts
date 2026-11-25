import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { assistantTools, isToolName, runTool } from "./tools";
import { freshTurnState, type ToolContext } from "./context";

const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  tenantId: "t", slug: "demo", channel: "web", businessName: "Demo", businessPhone: null, bookingLink: "https://x.test/book/demo", now: new Date(),
  channelCustomer: null, state: freshTurnState(), confirmedProposalId: null,
  conversation: {
    id: "c", tenantId: "t", channel: "web", status: "active", patientId: null, threadId: null, staffUserId: null, turnCount: 0, failureCount: 0, pendingId: null,
    pendingExpiresAt: null, verifiedPatientIds: [], shownAppointmentIds: [], otpSentAt: null, hasOtpPhone: false, lastActivityAt: new Date(),
  },
  ...overrides,
});

describe("the tool list", () => {
  const tools = assistantTools();
  it("is the same for everyone, in the same order, so the cached prompt never changes", () => {
    expect(tools.map((tool) => tool.name)).toEqual(["list_services", "list_staff", "find_times", "get_business_info", "hold_and_book", "request_verification_code", "find_my_bookings", "reschedule", "cancel", "hand_to_person"]);
    expect(JSON.stringify(assistantTools())).toBe(JSON.stringify(tools));
  });
  it("never lets the model name a business, tenant or customer", () => {
    for (const tool of tools) {
      const properties = Object.keys((tool.input_schema.properties ?? {}) as Record<string, unknown>);
      for (const forbidden of ["tenantId", "tenant", "business", "clinicSlug", "slug", "patientId", "customerId", "sql", "query"]) expect(properties, tool.name).not.toContain(forbidden);
    }
  });
  it("has no tool that commits a change on its own", () => {
    expect(tools.some((tool) => /^(confirm|commit|execute|book_now)/.test(tool.name))).toBe(false);
    for (const tool of tools) expect(JSON.stringify(tool.input_schema)).not.toMatch(/confirm|customerConfirmed/i);
  });
  it("closes every input object to extra fields", () => {
    for (const tool of tools) expect(tool.input_schema.additionalProperties, tool.name).toBe(false);
  });
});

describe("running a tool", () => {
  it("refuses a tool that does not exist", async () => {
    expect(isToolName("drop_database")).toBe(false);
    const result = await runTool(context(), "drop_database", {});
    expect(result.isError).toBe(true);
  });
  it("refuses extra and malformed input before anything runs", async () => {
    const extra = await runTool(context(), "hold_and_book", { serviceId: "s", personId: "p", startsAt: new Date().toISOString(), tenantId: "other" });
    expect(extra.isError).toBe(true);
    expect(extra.text).toContain("Invalid input");
    const badTime = await runTool(context(), "find_times", { serviceId: "s", from: "next saturday" });
    expect(badTime.isError).toBe(true);
    const injection = await runTool(context(), "find_times", { serviceId: "s'; drop table patients;--" });
    expect(injection.isError).toBe(true);
  });
  it("refuses bookings, changes and code checks that need a verified number", async () => {
    const mine = await runTool(context(), "find_my_bookings", {});
    expect(mine.isError).toBe(true);
    expect(mine.text).toContain("not verified");
    const cancel = await runTool(context(), "cancel", { appointmentId: "abc" });
    expect(cancel.isError).toBe(true);
  });
  it("only asks for a code on the website chat", async () => {
    const result = await runTool(context({ channel: "whatsapp" }), "request_verification_code", { phone: "+919800000000" });
    expect(result.isError).toBe(true);
  });
  it("counts every call toward the turn's limit", async () => {
    const state = freshTurnState();
    await runTool(context({ state }), "drop_database", {});
    await runTool(context({ state }), "find_my_bookings", {});
    expect(state.toolCalls).toBe(1);
  });
  it("records a handoff without letting the model choose what is said", async () => {
    const state = freshTurnState();
    const result = await runTool(context({ state }), "hand_to_person", { reason: "upset", summary: "The customer is frustrated about a late start." });
    expect(result.isError).toBe(false);
    expect(state.handoff?.reason).toBe("upset");
    const bad = await runTool(context(), "hand_to_person", { reason: "because", summary: "x" });
    expect(bad.isError).toBe(true);
  });
});
