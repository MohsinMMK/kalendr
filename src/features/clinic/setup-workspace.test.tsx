/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { SetupWorkspace } from "./setup-workspace";
import { TestQueryProvider } from "@/test/query-wrapper";
import { StaffSnapshotProvider } from "./staff-snapshot-provider";
import { chooseOption } from "@/test/choose-option";
import { staffSnapshotFixture } from "@/test/staff-fixture";
import { workingHoursSchema } from "@/server/contracts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri"];

describe("clinic setup", () => {
  it("submits Sunday-only hours using the server's ISO weekday contract", async () => {
    const snapshot = {
      ...staffSnapshotFixture,
      setup: {
        ...staffSnapshotFixture.setup,
        complete: false,
        missing: ["hours" as const],
      },
    };
    const request = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/staff/snapshot") {
        return new Response(JSON.stringify({ data: snapshot }));
      }
      const body = JSON.parse(String(options?.body)) as { hours: unknown };
      const hours = workingHoursSchema.parse(body.hours);
      expect(hours.days).toEqual([7]);
      snapshot.setup = { ...snapshot.setup, complete: true, missing: [] };
      return new Response(JSON.stringify({ data: {} }));
    });
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(
      <TestQueryProvider>
        <StaffSnapshotProvider role="owner">
          <SetupWorkspace />
        </StaffSnapshotProvider>
      </TestQueryProvider>,
    );
    await screen.findByRole("heading", { name: "Make it yours" });
    // The sample business already has its logo and cover, so the step offers Next.
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(
      screen.getByRole("heading", { name: "When do you see patients?" }),
    ).toHaveFocus();
    await user.click(screen.getByRole("radio", { name: "Weekdays, 9:00–17:00" }));
    for (const day of weekdays) {
      await user.click(screen.getByRole("button", { name: day }));
    }
    expect(screen.getByText("Choose at least one day.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save working hours" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Sun" }));
    await user.click(screen.getByRole("button", { name: "Save working hours" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "You’re live" }),
      ).toBeInTheDocument(),
    );
    expect(
      request.mock.calls.filter(([, options]) => options?.method === "PATCH"),
    ).toHaveLength(1);
  });

  it("walks a preview through a service, its provider and hours with no live writes", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<SetupWorkspace preview />);
    expect(screen.getByText("What you offer")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Let’s start" }));
    await user.click(screen.getByRole("radio", { name: /^Consultation/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText("Price in ₹ (optional)"), "800");
    await chooseOption(
      user,
      screen.getByRole("combobox", { name: "Space needed for this visit" }),
      "No dedicated room or chair",
    );
    await user.click(screen.getByRole("button", { name: /^Save / }));
    expect(
      screen.getByRole("heading", { name: /^Add a photo of this / }),
    ).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(
      screen.getByRole("heading", { name: "Who provides it?" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: /^Just me/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(screen.getByText("When you’re open")).toBeInTheDocument();
    for (const day of [...weekdays, "Sat"]) {
      await user.click(screen.getByRole("button", { name: day }));
    }
    expect(
      screen.getByRole("button", { name: "Save and go live" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Sat" }));
    await user.click(screen.getByRole("button", { name: "Save and go live" }));
    expect(
      screen.getByRole("heading", { name: "Your setup preview is complete." }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open my booking page" }),
    ).toHaveAttribute("href", "/book/indiranagar-dental");
    expect(screen.getByRole("link", { name: "Open my page" })).toHaveAttribute("href", "/b/indiranagar-dental");
    expect(screen.getByText(/₹800/)).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });
});
