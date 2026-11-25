import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestQueryProvider } from "@/test/query-wrapper";
import { WebsiteInstallGuide } from "./website-install-guide";

/** The saved sites list starts empty; adding one echoes it back. Every call is recorded. */
function stubSites() {
  const calls: { url: string; method: string; body: string | null }[] = [];
  const saved: { id: string; origin: string; createdAt: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : null });
    if (method === "POST") {
      const { origin } = JSON.parse(String(init?.body)) as { origin: string };
      saved.push({ id: "o1", origin, createdAt: new Date().toISOString() });
      return Response.json({ data: saved[0] }, { status: 201 });
    }
    return Response.json({ data: { origins: saved } });
  }));
  return calls;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("clinic website installation", () => {
  it("copies the real clinic URL and requires a valid frame origin for embed code", async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    const calls = stubSites();
    render(
      <TestQueryProvider>
        <WebsiteInstallGuide
          clinic={{ name: "Lotus Dental", slug: "lotus-dental" }}
        />
      </TestQueryProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Copy clinic booking link" }),
      ).toBeEnabled(),
    );
    await user.click(
      screen.getByRole("button", { name: "Copy clinic booking link" }),
    );
    expect(writeText).toHaveBeenCalledWith(
      new URL("/book/lotus-dental", window.location.origin).href,
    );
    await user.click(screen.getByRole("tab", { name: "Inline booking" }));
    expect(
      screen.getByRole("button", { name: "Copy clinic installation code" }),
    ).toBeDisabled();
    await user.type(
      screen.getByLabelText("Clinic website origin"),
      "https://clinic.example/path",
    );
    expect(screen.getByLabelText("Clinic website origin")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await user.clear(screen.getByLabelText("Clinic website origin"));
    await user.type(
      screen.getByLabelText("Clinic website origin"),
      "https://clinic.example",
    );
    await user.click(
      screen.getByRole("button", { name: "Copy clinic installation code" }),
    );
    expect(writeText).toHaveBeenLastCalledWith(
      expect.stringContaining("/book/lotus-dental?embed=1"),
    );
    // Copying the code is what allows the website to frame the booking page.
    expect(calls.filter((call) => call.method === "POST")).toEqual([
      { url: "/api/staff/embed-origins", method: "POST", body: JSON.stringify({ origin: "https://clinic.example" }) },
    ]);
    expect(await screen.findByText("is allowed to show your booking page.")).toBeVisible();
    expect(screen.getByLabelText("Clinic installation code")).toHaveTextContent(
      "Book with Lotus Dental",
    );
    await user.click(screen.getByRole("tab", { name: "Popup button" }));
    expect(screen.getByLabelText("Clinic installation code")).toHaveTextContent(
      'data-kalendr-clinic="lotus-dental"',
    );
  });
  it("keeps readable code when clipboard access fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new DOMException("Denied", "NotAllowedError"),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubSites();
    render(<TestQueryProvider><WebsiteInstallGuide clinic={{ name: "Lotus", slug: "lotus" }} /></TestQueryProvider>);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Copy clinic installation code" }),
      ).toBeEnabled(),
    );
    await user.click(
      screen.getByRole("button", { name: "Copy clinic installation code" }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Copy failed");
    expect(screen.getByLabelText("Clinic installation code")).toHaveTextContent(
      "/book/lotus",
    );
  });
});
