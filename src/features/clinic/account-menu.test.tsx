/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SidebarProvider } from "@/components/ui/sidebar";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: vi.fn() },
}));

import { BusinessProfileProvider } from "@/features/terms/business-profile-context";
import { resolveBusinessProfile } from "@/lib/terminology";

import { AccountMenu } from "./account-menu";
import { StaffThemeProvider } from "./theme";

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => { cleanup(); });

function renderMenu(preview: boolean, options: { role?: "owner" | "receptionist"; jobTitle?: string | null; roles?: Record<string, string> } = {}) {
  render(
    <StaffThemeProvider initial="light">
      <BusinessProfileProvider profile={options.roles ? resolveBusinessProfile({ businessType: "wellness", terminology: { roles: options.roles } }) : null}>
        <SidebarProvider>
          <AccountMenu userName="Meera Iyer" userEmail="meera@example.com" role={options.role ?? "owner"} jobTitle={options.jobTitle} preview={preview} />
        </SidebarProvider>
      </BusinessProfileProvider>
    </StaffThemeProvider>,
  );
}

describe("account section under the name", () => {
  it("shows the role's standard name until the business names it", () => {
    renderMenu(false, { role: "receptionist" });
    expect(screen.getByRole("button", { name: /Meera Iyer/ })).toHaveTextContent("Receptionist");
  });

  it("shows the business's own name for the role", () => {
    renderMenu(false, { role: "receptionist", roles: { receptionist: "Front desk" } });
    expect(screen.getByRole("button", { name: /Meera Iyer/ })).toHaveTextContent("Front desk");
  });

  it("leads with the person's job title when they have one", () => {
    renderMenu(false, { role: "receptionist", jobTitle: "Senior stylist", roles: { receptionist: "Front desk" } });
    const trigger = screen.getByRole("button", { name: /Meera Iyer/ });
    expect(trigger).toHaveTextContent("Senior stylist");
    expect(trigger).not.toHaveTextContent("Front desk");
  });
});

describe("account menu", () => {
  it("opens from the sidebar account control and offers sign out", async () => {
    const user = userEvent.setup();
    renderMenu(false);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Meera Iyer/ }));
    expect(await screen.findByRole("menu", { name: "Account" })).toBeInTheDocument();
    expect(screen.getByText("meera@example.com")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
  });

  it("has no sign out in preview, which has no session to end", async () => {
    const user = userEvent.setup();
    renderMenu(true);
    await user.click(screen.getByRole("button", { name: /Meera Iyer/ }));
    await screen.findByRole("menu", { name: "Account" });
    expect(screen.queryByRole("menuitem", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("shows Light, Dark and System side by side as menu choices the arrow keys reach, and keeps the menu open on a choice", async () => {
    const user = userEvent.setup();
    renderMenu(false);
    await user.click(screen.getByRole("button", { name: /Meera Iyer/ }));
    const menu = await screen.findByRole("menu", { name: "Account" });
    const group = screen.getByRole("group", { name: "Appearance" });
    const choices = ["Light", "Dark", "System"].map((name) => screen.getByRole("menuitemradio", { name }));
    for (const choice of choices) expect(group).toContainElement(choice);
    await user.click(choices[1]);
    expect(choices[1]).toHaveAttribute("aria-checked", "true");
    expect(menu).toBeInTheDocument();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(choices[2]);
    await user.keyboard("{Enter}");
    expect(choices[2]).toHaveAttribute("aria-checked", "true");
  });
});
