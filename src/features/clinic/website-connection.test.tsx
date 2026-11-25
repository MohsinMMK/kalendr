/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";

import { SettingsWorkspace } from "./settings-workspace";
import { normalizeExactOrigin, previewSettingsKey, readWebsiteSetups, saveWebsiteSetups, validateWebsiteDraft, websiteSnippet } from "./website-connection";
import type { WebsiteDraft, WebsiteSetup } from "./website-connection";

vi.mock("next/navigation", async () => (await import("./settings-router.test-helper")).settingsRouterMock);

afterEach(() => { cleanup(); window.sessionStorage.clear(); window.history.replaceState({}, "", "/"); vi.restoreAllMocks(); });

function draft(method: WebsiteSetup["method"]): WebsiteDraft {
  return { id: "setup_test", name: "Main website", websiteOriginsInput: "https://clinic.example", bookingOriginInput: "https://booking.example", method, buttonLabel: 'Book <now> & "save"', iframeHeightInput: "760" };
}

describe("website connection", () => {
  it("accepts only exact approved origins and escapes generated installation code", () => {
    expect(normalizeExactOrigin("https://clinic.example/", false)).toBe("https://clinic.example");
    for (const input of ["http://clinic.example", "https://clinic.example/path", "https://clinic.example/?x=1", "https://*.clinic.example", "https://user:pass@clinic.example", "javascript:alert(1)"]) {
      expect(normalizeExactOrigin(input, false)).toBeNull();
    }
    expect(normalizeExactOrigin("http://localhost:3000", true)).toBe("http://localhost:3000");
    expect(normalizeExactOrigin("http://localhost:3000", false)).toBeNull();
    const checked = validateWebsiteDraft(draft("link"), [], false);
    expect(checked.error).toBeUndefined();
    const setup = checked.setup!;
    expect(websiteSnippet(setup)).toBe('<a href="https://booking.example/book/indiranagar-dental">Book &lt;now&gt; &amp; &quot;save&quot;</a>');
    expect(websiteSnippet({ ...setup, method: "iframe" })).toContain("/book/indiranagar-dental?embed=1");
    expect(websiteSnippet({ ...setup, method: "iframe" })).toContain('min-height:760px');
    const popup = websiteSnippet({ ...setup, method: "popup" });
    expect(popup).toContain('src="https://booking.example/kalendr-widget.js?v=3"');
    expect(popup).toContain('data-kalendr-label="Book &lt;now&gt; &amp; &quot;save&quot;"');
    expect(popup).not.toContain("<now>");
    const api = websiteSnippet({ ...setup, method: "api" });
    expect(api).toContain("/api/public/availability");
    expect(api).toContain("/api/public/appointments");
    expect(api).toContain('"Idempotency-Key": idempotencyKey');
    expect(api).toContain("acceptedPrivacyNotice: true");
  });

  it("preserves other settings and ignores malformed saved website origins", () => {
    const valid = validateWebsiteDraft(draft("link"), [], false).setup!;
    window.sessionStorage.setItem(previewSettingsKey, JSON.stringify({ leadTime: "48", websiteSetups: [{ ...valid, bookingOrigin: "javascript:alert(1)" }, valid] }));
    expect(readWebsiteSetups()).toEqual([valid]);
    saveWebsiteSetups([valid, { ...valid, id: "setup_other", name: "Second website" }]);
    const persisted = JSON.parse(window.sessionStorage.getItem(previewSettingsKey) ?? "{}") as { leadTime: string; websiteSetups: WebsiteSetup[] };
    expect(persisted.leadTime).toBe("48");
    expect(persisted.websiteSetups).toHaveLength(2);
    expect(validateWebsiteDraft({ ...draft("iframe"), websiteOriginsInput: "https://clinic.example/page" }, [], false).error).toMatch(/exact HTTPS origins/);
  });

  it("guides a reviewed setup, copies full code, and keeps it after other settings save", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<NuqsTestingAdapter><SettingsWorkspace /></NuqsTestingAdapter>);
    await user.click(screen.getByRole("button", { name: "Website connection" }));
    expect(screen.getByRole("heading", { name: "Connect a website" })).toBeInTheDocument();
    // The four ways to connect a website; the "Booking forms" settings menu item is not one of them.
    expect(screen.getAllByRole("button", { name: /booking|integration/i }).filter((button) => !/^Booking forms/.test(button.textContent ?? ""))).toHaveLength(4);
    await user.click(screen.getByRole("button", { name: /Hosted booking link/ }));
    await user.type(screen.getByRole("textbox", { name: "Setup name" }), "Main website");
    await user.clear(screen.getByRole("textbox", { name: "Kalendr booking origin" }));
    await user.type(screen.getByRole("textbox", { name: "Kalendr booking origin" }), "https://booking.example");
    await user.type(screen.getByRole("textbox", { name: /Clinic website origins/ }), "https://clinic.example");
    await user.click(screen.getByRole("button", { name: /View installation/ }));
    const code = document.querySelector('pre[aria-label="Installation code"]')?.textContent;
    expect(code).toBe('<a href="https://booking.example/book/indiranagar-dental">Book an appointment</a>');
    await user.click(screen.getByRole("button", { name: "Copy installation code" }));
    expect(writeText).toHaveBeenCalledWith(code);
    await user.click(screen.getByRole("button", { name: /Review setup/ }));
    expect(window.sessionStorage.getItem(previewSettingsKey)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save preview setup" }));
    expect(screen.getByRole("status")).toHaveTextContent("Install the code on the website");
    expect(readWebsiteSetups()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "View website setups" }));
    expect(screen.getByText("Main website")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to settings" }));
    await user.click(screen.getByRole("button", { name: "Reminder channels" }));
    await user.click(screen.getByRole("switch", { name: "WhatsApp reminders" }));
    await user.click(screen.getByRole("button", { name: "Review changes" }));
    await user.click(screen.getByRole("button", { name: "Save preview settings" }));
    expect(readWebsiteSetups()).toHaveLength(1);
    cleanup();
    render(<NuqsTestingAdapter><SettingsWorkspace /></NuqsTestingAdapter>);
    await user.click(screen.getByRole("button", { name: "Website connection" }));
    await waitFor(() => expect(screen.getByText("Main website")).toBeInTheDocument());
  });

  it("keeps distinct popup and inline setups editable and removes one only after review", async () => {
    const user = userEvent.setup();
    render(<NuqsTestingAdapter><SettingsWorkspace /></NuqsTestingAdapter>);
    await user.click(screen.getByRole("button", { name: "Website connection" }));
    await user.click(screen.getByRole("button", { name: /Popup booking button/ }));
    await user.type(screen.getByRole("textbox", { name: "Setup name" }), "Front desk site");
    await user.type(screen.getByRole("textbox", { name: /Clinic website origins/ }), "https://frontdesk.example");
    await user.click(screen.getByRole("button", { name: /View installation/ }));
    expect(document.querySelector('pre[aria-label="Installation code"]')).toHaveTextContent("/kalendr-widget.js?v=3");
    await user.click(screen.getByRole("button", { name: /Review setup/ }));
    await user.click(screen.getByRole("button", { name: "Save preview setup" }));
    await user.click(screen.getByRole("button", { name: "View website setups" }));

    await user.click(screen.getByRole("button", { name: /Inline booking/ }));
    await user.type(screen.getByRole("textbox", { name: "Setup name" }), "Patient portal");
    await user.type(screen.getByRole("textbox", { name: /Clinic website origins/ }), "https://portal.example/path");
    await user.click(screen.getByRole("button", { name: /View installation/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("exact HTTPS origins");
    await user.clear(screen.getByRole("textbox", { name: /Clinic website origins/ }));
    await user.type(screen.getByRole("textbox", { name: /Clinic website origins/ }), "https://portal.example");
    await user.clear(screen.getByRole("spinbutton", { name: "Minimum iframe height (px)" }));
    await user.type(screen.getByRole("spinbutton", { name: "Minimum iframe height (px)" }), "900");
    await user.click(screen.getByRole("button", { name: /View installation/ }));
    expect(document.querySelector('pre[aria-label="Installation code"]')).toHaveTextContent("?embed=1");
    expect(document.querySelector('pre[aria-label="Installation code"]')).toHaveTextContent("min-height:900px");
    expect(screen.getByTitle("Local inline booking preview")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Review setup/ }));
    await user.click(screen.getByRole("button", { name: "Save preview setup" }));
    await user.click(screen.getByRole("button", { name: "View website setups" }));
    expect(readWebsiteSetups()).toHaveLength(2);

    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    await user.clear(screen.getByRole("textbox", { name: "Button label" }));
    await user.type(screen.getByRole("textbox", { name: "Button label" }), "Schedule a visit");
    await user.click(screen.getByRole("button", { name: /View installation/ }));
    await user.click(screen.getByRole("button", { name: /Review setup/ }));
    await user.click(screen.getByRole("button", { name: "Save preview setup" }));
    await user.click(screen.getByRole("button", { name: "View website setups" }));
    expect(readWebsiteSetups().find((item) => item.name === "Front desk site")?.buttonLabel).toBe("Schedule a visit");
    await user.click(screen.getAllByRole("button", { name: "Remove" })[1]);
    expect(screen.getByRole("heading", { name: "Remove website setup" })).toBeInTheDocument();
    expect(readWebsiteSetups()).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Remove preview setup" }));
    expect(readWebsiteSetups().map((item) => item.name)).toEqual(["Front desk site"]);
  });
});
