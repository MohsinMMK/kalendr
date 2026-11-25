/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import userEvent from "@testing-library/user-event";

import { TestQueryProvider } from "@/test/query-wrapper";
import { FollowUpsWorkspace } from "./follow-ups-workspace";
import { PatientsWorkspace } from "./patients-workspace";
import { SettingsWorkspace } from "./settings-workspace";

afterEach(() => { cleanup(); window.sessionStorage.clear(); window.history.replaceState({}, "", "/"); });

import { vi } from "vitest";

vi.mock("next/navigation", async () => (await import("./settings-router.test-helper")).settingsRouterMock);

describe("clinic support workspaces", () => {
  it("starts in the patient directory and restores a search after profile navigation", async () => {
    const user = userEvent.setup();
    render(<TestQueryProvider><PatientsWorkspace /></TestQueryProvider>);
    expect(screen.queryByRole("tablist", { name: "Patient details" })).not.toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search patients" }), "Priya");
    expect(screen.getByRole("table")).not.toHaveTextContent("Ananya");
    await user.click(screen.getByRole("button", { name: "Priya Patel" }));
    expect(screen.getByRole("tablist", { name: "Patient details" })).toBeInTheDocument();
    expect(window.location.search).toBe("?patient=patient_priya");
    await user.click(screen.getByRole("button", { name: "Back to patients" }));
    expect(screen.getByRole("searchbox", { name: "Search patients" })).toHaveValue("Priya");
    expect(within(screen.getByRole("table")).queryByText("Ankit Kapoor")).not.toBeInTheDocument();
  });

  it("reviews a compatible waitlist offer before recording it locally", async () => {
    const user = userEvent.setup();
    render(<FollowUpsWorkspace />);
    await user.click(screen.getByRole("button", { name: "Review Sara Ahmed" }));
    expect(screen.getByText("WhatsApp")).toBeInTheDocument();
    const opening = screen.getByRole("button", { name: /Tue, 1 Sept, 9:30 am.*Dr. Asha Mehta/ });
    await user.click(opening);
    expect(screen.getByRole("heading", { name: "Review follow-up" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to choices" }));
    expect(screen.getByRole("heading", { name: "Prepare a waitlist offer" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Tue, 1 Sept, 9:30 am.*Dr. Asha Mehta/ }));
    await user.click(screen.getByRole("button", { name: "Confirm offer" }));
    expect(screen.getByRole("status")).toHaveTextContent("No patient message was delivered.");
  });

  it("opens one patient page with view then edit, and keeps reminder drafts until a reviewed save", async () => {
    const user = userEvent.setup();
    const view = render(<NuqsTestingAdapter><SettingsWorkspace /></NuqsTestingAdapter>);
    expect(screen.queryByRole("heading", { name: "What patients currently see" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Patient page" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open section/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Patient page" })).toBeInTheDocument();
    expect(screen.getByText("Booking for Indiranagar Dental")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Reason for visit" })).toBeInTheDocument();
    expect(screen.getByText("Routine cleaning")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open your page" })).toHaveAttribute("href", "/b/indiranagar-dental");
    expect(screen.getByRole("link", { name: "Open booking" })).toHaveAttribute("href", "/book/indiranagar-dental");
    await user.click(screen.getByRole("tab", { name: "Edit" }));
    expect(screen.getByText(/saved on the clinic database/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reminder channels" }));
    await user.click(screen.getByRole("switch", { name: "WhatsApp reminders" }));
    await user.click(screen.getByRole("button", { name: "Review changes" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("switch", { name: "WhatsApp reminders" })).toBeChecked();
    expect(window.sessionStorage.getItem("kalendr-preview-settings-v1")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Review changes" }));
    await user.click(screen.getByRole("button", { name: "Save preview settings" }));
    expect(screen.getByRole("status")).toHaveTextContent("current browser preview");
    view.unmount();
    render(<NuqsTestingAdapter><SettingsWorkspace /></NuqsTestingAdapter>);
    await user.click(screen.getByRole("button", { name: "Reminder channels" }));
    expect(screen.getByRole("switch", { name: "WhatsApp reminders" })).toBeChecked();
  });
});
