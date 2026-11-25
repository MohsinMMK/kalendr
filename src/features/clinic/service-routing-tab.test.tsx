/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { serviceRoutingSchema, type ServiceRoutingView } from "@/lib/routing-contracts";
import { TestQueryProvider } from "@/test/query-wrapper";

import { ServiceRoutingTab, sharesFromWeights } from "./service-routing-tab";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const view: ServiceRoutingView = {
  serviceId: "svc1", serviceName: "Consultation", version: 3, assignment: "customer_chooses", preferReturningPerson: false,
  people: [{ practitionerId: "p1", name: "Asha", priority: 50, weight: 1 }, { practitionerId: "p2", name: "Ben", priority: 50, weight: 3 }],
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
const failure = (code: string, message: string, status: number) => new Response(JSON.stringify({ error: { code, message } }), { status });

function setup(options: { get?: () => Response; put?: (body: Record<string, unknown>) => Response; saves?: boolean } = {}) {
  const puts: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      puts.push(body);
      return options.put?.(body) ?? json({ ...view, version: 4 });
    }
    return options.get?.() ?? json(view);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<TestQueryProvider><ServiceRoutingTab serviceId="svc1" saves={options.saves ?? true} /></TestQueryProvider>);
  return { puts, fetchMock };
}

describe("sharesFromWeights", () => {
  it("rounds weights to percents and ignores a weight that is not valid", () => {
    expect(sharesFromWeights([1, 3])).toEqual([25, 75]);
    expect(sharesFromWeights([null, 2])).toEqual([0, 100]);
    expect(sharesFromWeights([])).toEqual([]);
  });
});

describe("service routing tab", () => {
  it("says it needs the live database in the preview and loads nothing", () => {
    const { fetchMock } = setup({ saves: false });
    expect(screen.getByText("Team routing needs the live database")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a loading state, then the people with their live share", async () => {
    setup();
    expect(screen.getByRole("status", { name: "Loading team routing" })).toBeInTheDocument();
    expect(await screen.findByText("Asha")).toBeInTheDocument();
    expect(screen.getByText("takes about 25%")).toBeInTheDocument();
    expect(screen.getByText("takes about 75%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save team routing" })).toBeDisabled();
  });

  it("shows the error and retries", async () => {
    const user = userEvent.setup();
    let calls = 0;
    setup({ get: () => (++calls === 1 ? failure("error", "Could not load.", 500) : json(view)) });
    expect(await screen.findByText("Could not load.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Asha")).toBeInTheDocument();
  });

  it("saves a body that matches the schema, with the version it loaded", async () => {
    const user = userEvent.setup();
    const { puts } = setup();
    await screen.findByText("Asha");
    await user.click(screen.getByRole("radio", { name: /Take turns/ }));
    const weight = screen.getByLabelText("Weight for Asha");
    await user.clear(weight);
    await user.type(weight, "3");
    expect(screen.getAllByText("takes about 50%")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Save team routing" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(serviceRoutingSchema.safeParse(puts[0]).success).toBe(true);
    expect(puts[0]).toEqual({
      assignment: "round_robin", preferReturningPerson: false, expectedVersion: 3,
      people: [{ practitionerId: "p1", priority: 50, weight: 3 }, { practitionerId: "p2", priority: 50, weight: 3 }],
    });
  });

  it("asks to load the latest when someone else saved first", async () => {
    const user = userEvent.setup();
    setup({ put: () => failure("version_conflict", "Changed.", 409) });
    await screen.findByText("Asha");
    await user.click(screen.getByRole("switch"));
    await user.click(screen.getByRole("button", { name: "Save team routing" }));
    expect(await screen.findByText("Someone else changed this")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load the latest" })).toBeInTheDocument();
  });
});
