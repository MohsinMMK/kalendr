/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PortalSignIn } from "./portal-sign-in";

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.replace.mockClear();
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;

function mockFetch(verify?: () => Response) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith("/api/portal/auth/")) return json({});
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    if (url === "/api/portal/auth/request") return json({ data: { sent: true } }, 202);
    if (url === "/api/portal/auth/verify") return verify ? verify() : json({ data: { signedIn: true } });
    throw new Error(`Unexpected ${url}`);
  }));
  return calls;
}

async function toCodeStep(user: ReturnType<typeof userEvent.setup>, kind: "email" | "phone") {
  if (kind === "phone") await user.click(screen.getByRole("button", { name: "Phone" }));
  await user.type(screen.getByLabelText(kind === "phone" ? /Phone number/ : /Email/), kind === "phone" ? "+919876543210" : "a@b.com");
  await user.click(screen.getByRole("button", { name: "Send code" }));
  await screen.findByText(/Six-digit code/);
}

describe("customer sign-in", () => {
  it("sends remember: true only when the box is ticked, off by default", async () => {
    const user = userEvent.setup();
    const calls = mockFetch();
    render(<PortalSignIn preview={false} />);
    await toCodeStep(user, "email");
    const box = screen.getByRole("checkbox", { name: "Remember this device for 30 days" });
    expect(box).not.toBeChecked();
    await user.click(box);
    await user.click(screen.getAllByRole("textbox")[0]);
    await user.keyboard("123456");
    await waitFor(() => expect(calls.some((call) => call.url === "/api/portal/auth/verify")).toBe(true));
    expect(calls.find((call) => call.url === "/api/portal/auth/verify")?.body).toEqual({ kind: "email", contact: "a@b.com", code: "123456", remember: true });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/portal"));
  });

  it("says the code comes by WhatsApp or text and can resend as a text message", async () => {
    const user = userEvent.setup();
    const calls = mockFetch();
    render(<PortalSignIn preview={false} />);
    await toCodeStep(user, "phone");
    expect(screen.getByRole("status")).toHaveTextContent("WhatsApp or text message");
    expect(calls[0].body).toEqual({ kind: "phone", contact: "+919876543210" });
    await user.click(screen.getByRole("button", { name: "More ways to get a code" }));
    await user.click(await screen.findByRole("menuitem", { name: "Send it as a text message instead" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].body).toEqual({ kind: "phone", contact: "+919876543210", via: "text" });
    expect(await screen.findByText(/by text message/)).toBeInTheDocument();
  });

  it("does not offer the text-message option for email", async () => {
    const user = userEvent.setup();
    mockFetch();
    render(<PortalSignIn preview={false} />);
    await toCodeStep(user, "email");
    expect(screen.queryByRole("button", { name: "More ways to get a code" })).not.toBeInTheDocument();
  });

  it("shows the wait message and keeps the code boxes after code_retry_later", async () => {
    const user = userEvent.setup();
    mockFetch(() => json({ error: { code: "code_retry_later", message: "Wait 20 seconds and try again." } }, 429));
    render(<PortalSignIn preview={false} />);
    await toCodeStep(user, "email");
    await user.click(screen.getAllByRole("textbox")[0]);
    await user.keyboard("111111");
    expect(await screen.findByText("Wait 20 seconds and try again.")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(6);
  });
});
