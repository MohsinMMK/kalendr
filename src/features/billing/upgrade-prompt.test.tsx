/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StaffApiError } from "@/features/clinic/queries/http";
import { TestQueryProvider } from "@/test/query-wrapper";

const navigation = vi.hoisted(() => ({ push: vi.fn(), pathname: "/doctors" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: navigation.push }), usePathname: () => navigation.pathname }));

import { BillingBanners } from "./billing-banners";
import { fixedNow, makeState, paidState, inDays } from "./billing-fixtures";
import { onBillingRequest } from "./billing-navigation";
import { UpgradePromptProvider, useUpgradePrompt } from "./upgrade-prompt";

const limitError = () => new StaffApiError("Your plan allows 3 calendars.", 403, "plan_limit", {}, { subject: "staffCalendars", requiredPlan: "growth", currentPlan: "starter", limit: 3 });

let handled: boolean | null;
function Trigger({ error = limitError() }: { error?: unknown }) {
  const upgrade = useUpgradePrompt();
  return <button type="button" onClick={() => { handled = upgrade.fromError(error); }}>Add calendar</button>;
}

beforeEach(() => {
  handled = null;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: paidState("starter") }), { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const mount = (owner: boolean, error?: unknown) => render(
  <TestQueryProvider><UpgradePromptProvider billingEnabled={owner} isOwner={owner}><Trigger error={error} /></UpgradePromptProvider></TestQueryProvider>,
);

describe("upgrade dialog from a plan_limit error", () => {
  it("opens with the plan limits and the required plan's price, and sends an owner to the plans", async () => {
    const user = userEvent.setup();
    const asked = vi.fn();
    const off = onBillingRequest(asked);
    mount(true);
    await user.click(screen.getByRole("button", { name: "Add calendar" }));
    expect(handled).toBe(true);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Your Starter plan includes 3 \S+ calendars. Growth includes 10./)).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByText(/₹1,499 a month/)).toBeInTheDocument());
    await user.click(within(dialog).getByRole("button", { name: "See plans" }));
    expect(asked).toHaveBeenCalledTimes(1);
    expect(navigation.push).toHaveBeenCalledWith("/settings");
    off();
  });

  it("tells someone who is not the owner to ask the owner, with no plans button", async () => {
    const user = userEvent.setup();
    mount(false);
    await user.click(screen.getByRole("button", { name: "Add calendar" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Ask the owner/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "See plans" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores other errors, and does nothing at all with no provider mounted", async () => {
    const user = userEvent.setup();
    mount(true, new StaffApiError("Nope", 409, "version_conflict"));
    await user.click(screen.getByRole("button", { name: "Add calendar" }));
    expect(handled).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();
    render(<Trigger />);
    await user.click(screen.getByRole("button", { name: "Add calendar" }));
    expect(handled).toBe(false);
  });

  it("still opens, with plain words, when the server sent no details", async () => {
    const user = userEvent.setup();
    mount(true, new StaffApiError("Upgrade needed", 403, "plan_limit"));
    await user.click(screen.getByRole("button", { name: "Add calendar" }));
    expect(await screen.findByText("Your current plan does not include this.")).toBeInTheDocument();
  });
});

describe("billing banners", () => {
  function banners(enabled: boolean, state: ReturnType<typeof makeState>) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: state }), { status: 200 })));
    return render(<TestQueryProvider><BillingBanners enabled={enabled} /></TestQueryProvider>);
  }
  const pastDue = () => paidState("starter", { status: "past_due", graceEndsAt: "2099-01-05T10:00:00.000Z" }, { banner: { kind: "past_due", graceEndsAt: "2099-01-05T10:00:00.000Z" } });

  it("shows the failed payment to the owner with a way to fix it", async () => {
    banners(true, pastDue());
    expect(await screen.findByText(/Your last payment didn't go through. Update your payment method by 5 Jan 2099 to keep your plan./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update payment" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Hide/ })).toBeNull();
  });

  it("shows nothing and asks for nothing when it is not the owner", () => {
    banners(false, pastDue());
    expect(screen.queryByText(/payment didn't go through/)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows a trial chip with 3 days left and hides it for the day when dismissed", async () => {
    const user = userEvent.setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fixedNow);
    try { window.localStorage.clear(); } catch { /* none */ }
    banners(true, makeState({ trialEndsAt: inDays(2) }));
    vi.useRealTimers();
    expect(await screen.findByText(/trial ends in 2 days/)).toBeInTheDocument();
    await act(async () => { await user.click(screen.getByRole("button", { name: "Hide until tomorrow" })); });
    expect(screen.queryByText(/trial ends in/)).toBeNull();
  });

  it("stays away when the trial has more than 3 days left", async () => {
    banners(true, makeState());
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByText(/trial ends/)).toBeNull();
  });
});
