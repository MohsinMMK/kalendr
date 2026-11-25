/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BusinessProfileProvider } from "@/features/terms/business-profile-context";
import { resolvePermissions } from "@/lib/permissions";
import { resolveBusinessProfile } from "@/lib/terminology";
import { parseWorkspaceLayout, type WorkspaceLayout } from "@/lib/workspace-layout";

import { SidebarEditor } from "./customize-sidebar";
import { StaffAccessProvider } from "./staff-access";
import { WorkspaceLayoutProvider } from "./workspace-layout-provider";

const profile = resolveBusinessProfile({ businessType: "wellness" });

let saved: WorkspaceLayout[] = [];

beforeEach(() => {
  saved = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    saved.push(parseWorkspaceLayout(JSON.parse(String(init?.body))));
    return new Response("{}");
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderEditor(options: { canEdit?: boolean; layout?: unknown; role?: "owner" | "receptionist" } = {}) {
  const role = options.role ?? "owner";
  return render(
    <StaffAccessProvider role={role} permissions={resolvePermissions(role, {})} userId="user-1">
      <BusinessProfileProvider profile={profile}>
        <WorkspaceLayoutProvider initial={parseWorkspaceLayout(options.layout ?? {})} preview={false} canEdit={options.canEdit ?? true}>
          <SidebarEditor />
        </WorkspaceLayoutProvider>
      </BusinessProfileProvider>
    </StaffAccessProvider>,
  );
}

const lastSaved = () => saved.at(-1)?.pages.sidebar;
const names = () => screen.getAllByRole("textbox", { name: /^Name for / }).map((field) => (field as HTMLInputElement).value);

describe("the sidebar editor", () => {
  it("lists both sections in the business's words, with the entries this person has", () => {
    renderEditor();
    expect(screen.getAllByRole("textbox", { name: "Section heading" }).map((field) => (field as HTMLInputElement).value)).toEqual(["Front desk", "Salon"]);
    expect(names().slice(0, 7)).toEqual(["Today", "Schedule", "Bookings", "Clients", "Follow-ups", "Classes", "Messages"]);
    // Records is off for a salon, so it is not offered.
    expect(screen.queryByRole("textbox", { name: "Name for Records" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name for Stylists" })).toHaveValue("Stylists");
  });

  it("only offers an entry's switch when it can be hidden", () => {
    renderEditor();
    expect(screen.getByRole("switch", { name: "Show Offers in the sidebar" })).toBeChecked();
    for (const locked of ["Settings", "Help"]) {
      expect(screen.queryByRole("switch", { name: `Show ${locked} in the sidebar` })).not.toBeInTheDocument();
      expect(screen.getByRole("img", { name: `${locked} is always shown` })).toBeInTheDocument();
    }
    expect(screen.getByRole("img", { name: "My profile is always shown" })).toBeInTheDocument();
  });

  it("renames an entry when Enter is pressed and saves only that difference", async () => {
    renderEditor();
    const user = userEvent.setup();
    const field = screen.getByRole("textbox", { name: "Name for Schedule" });
    await user.clear(field);
    await user.type(field, "Diary{Enter}");
    await waitFor(() => expect(lastSaved()?.options).toEqual({ "name-schedule": "Diary" }));
    expect(lastSaved()?.lists).toBeUndefined();
  });

  it("puts the standard name back when a name is emptied", async () => {
    renderEditor({ layout: { pages: { sidebar: { options: { "name-schedule": "Diary" } } } } });
    const user = userEvent.setup();
    const field = screen.getByRole("textbox", { name: "Name for Schedule" });
    expect(field).toHaveValue("Diary");
    await user.clear(field);
    await user.tab();
    expect(field).toHaveValue("Schedule");
    await waitFor(() => expect(lastSaved()).toEqual({}));
  });

  it("renames a section heading", async () => {
    renderEditor();
    const user = userEvent.setup();
    const field = screen.getAllByRole("textbox", { name: "Section heading" })[0]!;
    await user.clear(field);
    await user.type(field, "Reception{Enter}");
    await waitFor(() => expect(lastSaved()?.options).toEqual({ "heading-front-desk": "Reception" }));
  });

  it("hides and shows an entry", async () => {
    renderEditor();
    const user = userEvent.setup();
    const offers = screen.getByRole("switch", { name: "Show Offers in the sidebar" });
    await user.click(offers);
    await waitFor(() => expect(lastSaved()?.lists?.entries?.hidden).toEqual(["offers"]));
    expect(offers).not.toBeChecked();
    await user.click(offers);
    await waitFor(() => expect(lastSaved()).toEqual({}));
  });

  it("moves an entry with Alt and the arrow keys and saves the order", async () => {
    renderEditor();
    const today = screen.getByRole("textbox", { name: "Name for Today" });
    today.focus();
    fireEvent.keyDown(today, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(names().slice(0, 3)).toEqual(["Schedule", "Today", "Bookings"]));
    await waitFor(() => expect(lastSaved()?.lists?.entries?.order?.slice(0, 3)).toEqual(["schedule", "dashboard", "bookings"]));
  });

  it("keeps a name typed just before Alt and an arrow key moves the entry", async () => {
    renderEditor();
    const user = userEvent.setup();
    const today = screen.getByRole("textbox", { name: "Name for Today" });
    await user.clear(today);
    await user.type(today, "Front desk");
    fireEvent.keyDown(today, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(lastSaved()?.lists?.entries?.order?.slice(0, 2)).toEqual(["schedule", "dashboard"]));
    expect(lastSaved()?.options).toEqual({ "name-dashboard": "Front desk" });
    expect(saved).toHaveLength(1);
  });

  it("resets everything to the defaults, and only offers it once something is changed", async () => {
    renderEditor({ layout: { pages: { sidebar: { lists: { entries: { hidden: ["offers"] } }, options: { "name-schedule": "Diary" } } } } });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Reset sidebar" }));
    await waitFor(() => expect(lastSaved()).toEqual({}));
    expect(screen.getByRole("textbox", { name: "Name for Schedule" })).toHaveValue("Schedule");
    expect(screen.getByRole("button", { name: "Reset sidebar" })).toBeDisabled();
  });

  it("is read-only for someone who cannot arrange the workspace", () => {
    renderEditor({ canEdit: false, role: "receptionist" });
    expect(screen.getByRole("note")).toHaveTextContent("Only the owner or an admin can change the sidebar.");
    expect(screen.getByRole("textbox", { name: "Name for Schedule" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Show Messages in the sidebar" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Reset sidebar" })).toBeDisabled();
  });

  it("leaves out entries the person has no access to", () => {
    renderEditor({ role: "receptionist", canEdit: false });
    const list = within(screen.getAllByRole("group", { name: /in the order shown in the sidebar/ })[1]!);
    // A receptionist does not manage campaigns or routing forms.
    expect(list.queryByRole("textbox", { name: "Name for Campaigns" })).not.toBeInTheDocument();
    expect(list.queryByRole("textbox", { name: "Name for Routing forms" })).not.toBeInTheDocument();
    expect(list.getByRole("textbox", { name: "Name for Reports" })).toBeInTheDocument();
  });
});
