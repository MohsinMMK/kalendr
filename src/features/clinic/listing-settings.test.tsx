/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "@/components/ui/toast";
import type { ListingView } from "@/lib/listing";
import { TestQueryProvider } from "@/test/query-wrapper";

import { ListingSettings } from "./listing-settings";

const view = (extra: Partial<ListingView> = {}): ListingView => ({
  listed: false, seo: {}, indexable: false, blockers: [], businessName: "Smile Dental", city: "Pune", pageUrl: "https://kalendr.example/b/smile",
  defaultTitle: "Book an appointment at Smile Dental, Pune", defaultDescription: "Book an appointment at Smile Dental in Pune.", links: [], emailSignature: "", preview: false, ...extra,
});

let calls: { url: string; method: string; body: unknown }[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ data: view({ listed: true, indexable: true }) }), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const renderIt = (extra: Partial<ListingView> = {}) => render(<ToastProvider><TestQueryProvider><ListingSettings view={view(extra)} /></TestQueryProvider></ToastProvider>);

describe("listing settings", () => {
  it("starts off, hidden from search engines, with a preview of the search result", () => {
    renderIt();
    expect(screen.getByRole("switch", { name: /find us on Google/ })).not.toBeChecked();
    expect(screen.getByText("Hidden from search engines")).toBeInTheDocument();
    expect(screen.getByRole("figure", { name: /search result/ })).toHaveTextContent("Book an appointment at Smile Dental, Pune");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("previews the owner's own words as they type", async () => {
    renderIt();
    await userEvent.type(screen.getByLabelText("Page title"), "Smile, the gentle dentist");
    expect(screen.getByRole("figure", { name: /search result/ })).toHaveTextContent("Smile, the gentle dentist");
  });

  it("saves the switch with what it last saw, so a clash is caught", async () => {
    renderIt();
    await userEvent.click(screen.getByRole("switch", { name: /find us on Google/ }));
    await userEvent.type(screen.getByLabelText("Page description"), "Gentle care.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ url: "/api/staff/settings/listing", method: "PATCH", body: { listed: true, seo: { description: "Gentle care." }, expected: { listed: false, seo: {} } } });
  });

  it("says why a listed business is still hidden", () => {
    renderIt({ listed: true, blockers: ["Your plan has ended. Choose a plan in Billing to get found again."] });
    expect(screen.getByText(/Your plan has ended/)).toBeInTheDocument();
  });

  it("refuses a title that is too long", async () => {
    renderIt();
    const title = screen.getByLabelText("Page title");
    expect(title).toHaveAttribute("maxlength", "70");
  });
});
