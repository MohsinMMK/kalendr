/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { permissionKeys } from "@/lib/permissions";
import type { PreviewResult, RoutingBuilderOptions, RoutingFormDetail, RoutingFormSummary, RoutingFormView, RoutingReport, WrongAssignmentView } from "@/lib/routing-forms";
import { routingDraftSchema } from "@/lib/routing-forms";
import { profileWords, defaultBusinessProfile } from "@/lib/terminology";
import { runBarAction } from "@/test/choose-option";
import { failure, installFetch, json, stubKeys, type Req } from "@/test/offers-fixtures";
import { TestQueryProvider } from "@/test/query-wrapper";

let search = "";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(search) }));

import { RoutingFormsWorkspace } from "./routing-forms-workspace";
import { buildTemplateDraft } from "./routing-form-templates";
import { StaffAccessProvider } from "../staff-access";
import { StaffSnapshotProvider } from "../staff-snapshot-provider";

const terms = profileWords(defaultBusinessProfile);
const summary = (patch: Partial<RoutingFormSummary> = {}): RoutingFormSummary => ({
  id: "f1", key: "rf_1", name: "Find the right visit", slug: "find", status: "live", version: 3, routeCount: 2, responses30d: 42, updatedAt: "2026-11-01T00:00:00.000Z", ...patch,
});
const options: RoutingBuilderOptions = {
  services: [{ id: "s1", name: "Cleaning", active: true, hidden: false }, { id: "s2", name: "Whitening", active: true, hidden: false }],
  people: [{ id: "p1", name: "Dr Iyer" }],
  attributes: [{ id: "a1", name: "Language", kind: "multiple", options: ["Tamil", "Hindi"] }],
  bookingKeys: ["source"],
};
const view = (patch: Partial<RoutingFormView> = {}): RoutingFormView => ({
  id: "f1", key: "rf_1", name: "Find the right visit", slug: "find", intro: "", status: "draft", version: 1, revision: 4, hasUnpublishedChanges: true, updatedAt: "2026-11-01T00:00:00.000Z",
  definition: {
    questions: [{ id: "q_name", type: "short_text", label: "Your name", required: true }],
    routes: [{ id: "r1", name: "Everyone", conditions: [], destination: { type: "service", serviceId: "s1", people: { personIds: [], filters: [], weights: [] } } }],
    fallback: { type: "service", serviceId: "s1", people: { personIds: [], filters: [], weights: [] } },
  },
  ...patch,
});
const detail = (patch: Partial<RoutingFormView> = {}): RoutingFormDetail => ({ form: view(patch), warnings: [] });
const report: RoutingReport = {
  from: "2026-10-22T00:00:00.000Z", to: "2026-11-21T00:00:00.000Z", opened: 100, answered: 80, slotShown: 60, booked: 30, answeredNotBooked: 20, abandonedAfterHours: 2,
  perRoute: [{ routeId: "r1", name: "Everyone", responses: 80, booked: 30, notBooked: 20 }], answeredNotBookedLastWeek: 7,
};
const wrong = (patch: Partial<WrongAssignmentView> = {}): WrongAssignmentView => ({
  id: "w1", appointmentId: "a1", startsAt: "2026-11-20T09:00:00.000Z", serviceName: "Cleaning", assignedName: "Dr Rao", correctName: "Dr Iyer", note: "Asked for Tamil", routeName: "Tamil speakers", reportedBy: "Meera", status: "open", version: 2, createdAt: "2026-11-20T10:00:00.000Z", ...patch,
});

function renderWorkspace({ database = true }: { database?: boolean } = {}) {
  const inner = <StaffAccessProvider role="owner" permissions={permissionKeys} userId={null}><RoutingFormsWorkspace /></StaffAccessProvider>;
  return render(<TestQueryProvider>{database ? <StaffSnapshotProvider role="owner">{inner}</StaffSnapshotProvider> : inner}</TestQueryProvider>);
}

/** Answers every routing-form call; `extra` can take over a request first. */
function install(extra: (request: Req, url: URL) => Response | Promise<Response> | undefined = () => undefined, forms: RoutingFormSummary[] = [summary()], current: RoutingFormDetail = detail()) {
  return installFetch((request, url) => {
    const taken = extra(request, url);
    if (taken) return taken;
    const path = url.pathname.replace("/api/staff/routing-forms", "");
    if (path === "" && request.method === "GET") return json(forms);
    if (path === "/options") return json(options);
    if (path === "/report") return json(report);
    if (path === "/wrong-assignments") return json([wrong()]);
    if (path === "/f1" && request.method === "GET") return json(current);
    return undefined;
  });
}

beforeEach(() => { stubKeys(); search = ""; window.history.replaceState({}, "", "/routing-forms"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("routing forms list", () => {
  it("shows loading, then each form with its status, version and responses", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    install((request, url) => (url.pathname === "/api/staff/routing-forms" && request.method === "GET" ? held.then(() => json([summary(), summary({ id: "f2", name: "Second", status: "draft", version: 1, responses30d: 1, routeCount: 1 })])) : undefined));
    renderWorkspace();
    expect(await screen.findByRole("status", { name: "Loading routing forms" })).toBeInTheDocument();
    release();
    const list = await screen.findByRole("list", { name: "Routing forms" });
    expect(within(list).getByText("Find the right visit")).toBeInTheDocument();
    expect(within(list).getByText("Live")).toBeInTheDocument();
    expect(within(list).getByText("Draft")).toBeInTheDocument();
    expect(within(list).getByText("Version 3 · 2 routes")).toBeInTheDocument();
    expect(within(list).getByText("42 responses in 30 days")).toBeInTheDocument();
    expect(within(list).getByText("1 response in 30 days")).toBeInTheDocument();
  });

  it("explains an empty list", async () => {
    install(undefined, []);
    renderWorkspace();
    expect(await screen.findByText("No routing forms yet")).toBeInTheDocument();
  });

  it("offers three starter templates on an empty list, and a click saves a draft the create route accepts, then opens it", async () => {
    const user = userEvent.setup();
    const created = detail({ id: "f9", name: `Which ${terms.service} do you need?`, status: "draft" });
    const requests = install((request, url) => {
      if (url.pathname === "/api/staff/routing-forms" && request.method === "POST") return json(created, 201);
      if (url.pathname === "/api/staff/routing-forms/f9") return json(created);
      return undefined;
    }, []);
    renderWorkspace();
    const section = await screen.findByRole("region", { name: "Start from a template" });
    expect(within(section).getAllByRole("button").map((button) => button.textContent)).toEqual([
      expect.stringContaining(`Which ${terms.service} do you need?`), expect.stringContaining(`New or returning ${terms.customer}`), expect.stringContaining(`Pick a ${terms.location}`),
    ]);
    await waitFor(() => expect(requests.some((request) => request.url.endsWith("/options"))).toBe(true));
    await user.click(within(section).getByRole("button", { name: new RegExp(`Which ${terms.service} do you need`) }));
    await waitFor(() => expect(requests.find((request) => request.method === "POST")).toBeDefined());
    const post = requests.find((request) => request.method === "POST")!;
    const parsed = routingDraftSchema.safeParse(post.body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe(`Which ${terms.service} do you need?`);
      expect(parsed.data.definition.questions[0]?.options).toEqual(["Cleaning", "Whitening"]);
    }
    expect(await screen.findByText("Route 1 of 1")).toBeInTheDocument();
  });

  it("builds a valid draft for every template, with or without services", () => {
    for (const id of ["service", "returning", "location"] as const) {
      for (const services of [options, { services: [] }, null]) {
        expect(routingDraftSchema.safeParse(buildTemplateDraft(id, terms, services, "ab12c")).success).toBe(true);
      }
    }
  });

  it("shows an error with a retry, and sends nothing in the preview", async () => {
    const user = userEvent.setup();
    let calls = 0;
    install((request, url) => (url.pathname === "/api/staff/routing-forms" && request.method === "GET" ? (++calls === 1 ? failure(500, "server_error", "The list is down.") : json([summary()])) : undefined));
    renderWorkspace();
    expect(await screen.findByText("The list is down.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Routing forms" })).toBeInTheDocument();
    cleanup();
    const requests = install();
    renderWorkspace({ database: false });
    expect(screen.getByText("Routing forms are not available in the preview")).toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });
});

describe("routing form builder", () => {
  it("adds a route and warns when an earlier route already catches everyone", async () => {
    const user = userEvent.setup();
    install();
    renderWorkspace();
    await user.click(await screen.findByRole("button", { name: /Find the right visit/ }));
    expect(await screen.findByText("Route 1 of 1")).toBeInTheDocument();
    expect(screen.queryByText(/can never be reached/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add a route" }));
    expect(await screen.findByText("Route 2 of 2")).toBeInTheDocument();
    const warning = await screen.findAllByText(/can never be reached/);
    expect(warning[0]).toHaveTextContent("“Route 2” can never be reached");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("moves a route down with the keyboard-reachable buttons", async () => {
    const user = userEvent.setup();
    install();
    renderWorkspace();
    await user.click(await screen.findByRole("button", { name: /Find the right visit/ }));
    await user.click(await screen.findByRole("button", { name: "Add a route" }));
    await user.click(screen.getByRole("button", { name: "Move route 1 down" }));
    const names = screen.getAllByLabelText("Route name").map((input) => (input as HTMLInputElement).value);
    expect(names).toEqual(["Route 2", "Everyone"]);
  });

  it("blocks publishing a form that cannot be saved yet", async () => {
    const user = userEvent.setup();
    install();
    renderWorkspace();
    await user.click(await screen.findByRole("button", { name: "New routing form" }));
    expect(await screen.findByText("New routing form", { selector: "h1" })).toBeInTheDocument();
    for (const more of screen.getAllByRole("button", { name: "More actions" })) {
      await user.click(more);
      const item = within(await screen.findByRole("menu")).queryByRole("menuitem", { name: /Publish/ });
      if (item) { expect(item).toHaveAttribute("aria-disabled", "true"); return; }
      await user.keyboard("{Escape}");
    }
    const inline = screen.getByRole("button", { name: "Publish" });
    expect(inline).toBeDisabled();
  });

  it("saves, then publishes the saved revision", async () => {
    const user = userEvent.setup();
    const requests = install((request, url) => {
      if (url.pathname === "/api/staff/routing-forms/f1/publish") return json(detail({ status: "live", version: 2, revision: 4, hasUnpublishedChanges: false }));
      return undefined;
    });
    renderWorkspace();
    await user.click(await screen.findByRole("button", { name: /Find the right visit/ }));
    await screen.findByText("Route 1 of 1");
    await runBarAction(user, "Publish");
    await waitFor(() => expect(requests.find((request) => request.url.endsWith("/f1/publish"))?.body).toEqual({ expectedRevision: 4 }));
    expect(await screen.findByText("Live version 2")).toBeInTheDocument();
  });

  it("asks to reload when someone else changed the form", async () => {
    const user = userEvent.setup();
    install((request) => (request.method === "PUT" ? failure(409, "version_conflict", "Stale.") : undefined));
    renderWorkspace();
    await user.click(await screen.findByRole("button", { name: /Find the right visit/ }));
    await user.click(await screen.findByRole("button", { name: "Add a route" }));
    await runBarAction(user, "Save");
    expect(await screen.findByText("Someone else changed this form")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload the form" })).toBeInTheDocument();
  });
});

describe("routing form preview", () => {
  it("runs the saved form and shows the matched route, the trace and who is offered", async () => {
    const user = userEvent.setup();
    const result: PreviewResult = {
      routeId: "r1", routeName: "Everyone", destination: view().definition.fallback,
      trace: { routes: [{ routeId: "r1", name: "Everyone", matched: true, conditions: [] }], matchedRouteId: "r1", matchedRouteName: "Everyone", people: [] },
      offered: [{ personId: "p1", name: "Dr Iyer", multiplier: 2 }],
    };
    const requests = install((request, url) => (url.pathname.endsWith("/f1/preview") ? json(result) : undefined));
    renderWorkspace();
    await user.click(await screen.findByRole("button", { name: /Find the right visit/ }));
    await screen.findByText("Route 1 of 1");
    await runBarAction(user, "Preview");
    expect(await screen.findByText(/Nothing is saved/)).toBeInTheDocument();
    await user.type(await screen.findByLabelText(/Your name/), "Asha");
    await user.click(screen.getByRole("button", { name: "Show the result" }));
    expect(await screen.findByText("Matched: Everyone")).toBeInTheDocument();
    expect(screen.getByText("Counts 2 times")).toBeInTheDocument();
    expect(requests.find((request) => request.url.endsWith("/preview"))?.body).toEqual({ answers: { q_name: "Asha" } });
  });
});

describe("routing report and wrong assignments", () => {
  it("shows the funnel numbers, the big number and each route", async () => {
    const user = userEvent.setup();
    install();
    renderWorkspace();
    await user.click(await screen.findByRole("tab", { name: "Report" }));
    expect(await screen.findByLabelText(/7 \S+ answered but did not book last week/)).toBeInTheDocument();
    const funnel = screen.getByRole("list", { name: "From opening to booking" });
    expect(within(funnel).getByText("Opened the form").parentElement).toHaveTextContent("100");
    expect(within(funnel).getByText("Booked").parentElement).toHaveTextContent("30");
    const row = screen.getByRole("row", { name: /Everyone/ });
    expect(row).toHaveTextContent("80");
    expect(screen.getByRole("link", { name: /Export CSV/ })).toHaveAttribute("href", expect.stringContaining("/api/staff/routing-forms/report/export?"));
  });

  it("marks a wrong assignment fixed with the version it saw", async () => {
    const user = userEvent.setup();
    const requests = install((request, url) => (url.pathname === "/api/staff/routing-forms/wrong-assignments/w1" && request.method === "PATCH" ? json(wrong({ status: "fixed", version: 3 })) : undefined));
    renderWorkspace();
    await user.click(await screen.findByRole("tab", { name: "Wrong assignments" }));
    expect(await screen.findByText("Dr Rao")).toBeInTheDocument();
    expect(screen.getByText("Asked for Tamil")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Mark fixed/ }));
    await waitFor(() => expect(requests.find((request) => request.method === "PATCH")?.body).toEqual({ status: "fixed", expectedVersion: 2 }));
  });

  it("explains when nothing needs fixing", async () => {
    const user = userEvent.setup();
    install((_request, url) => (url.pathname.endsWith("/wrong-assignments") ? json([]) : undefined));
    renderWorkspace();
    await user.click(await screen.findByRole("tab", { name: "Wrong assignments" }));
    expect(await screen.findByText("Nothing to fix")).toBeInTheDocument();
  });
});
