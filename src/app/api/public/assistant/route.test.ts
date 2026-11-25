/** @vitest-environment node */
import { createUIMessageStream } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const web = vi.hoisted(() => ({ chat: vi.fn(), received: [] as Array<{ body: unknown; address: string }> }));

vi.mock("@/server/assistant/web", () => ({
  webChat: async (body: unknown, address: string) => { web.received.push({ body, address }); return web.chat(); },
  publicAssistantConfig: async () => ({ enabled: true, businessName: "Lotus", bookingLink: "https://app.test/book/lotus", greeting: "Chat" }),
  webTranscript: async () => null,
}));
vi.mock("@/server/http", async (original) => ({ ...(await original<typeof import("@/server/http")>()), enforceLimit: async () => undefined }));

import { ApiError } from "@/server/api-error";

import { POST } from "./route";

const post = (body: unknown, headers: Record<string, string> = {}) => POST(new Request("http://localhost/api/public/assistant", {
  method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", ...headers }, body: JSON.stringify(body),
}));

async function chunksOf(response: Response): Promise<Array<Record<string, unknown>>> {
  const body = await response.text();
  return body.split("\n\n").flatMap((frame) => {
    // Comment frames (the stream-open and keep-alive marks) carry no chunk.
    if (frame.trim().startsWith(":")) return [];
    const data = frame.replace(/^data: /, "").trim();
    return data && data !== "[DONE]" ? [JSON.parse(data) as Record<string, unknown>] : [];
  });
}

beforeEach(() => {
  web.received = [];
  web.chat.mockReset();
});

describe("POST /api/public/assistant", () => {
  it("streams the answer as UI message chunks, with the typed parts, and never caches it", async () => {
    web.chat.mockImplementation(() => createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "data-conversation", data: { token: "t".repeat(43), status: "active", awaitingCode: false, verified: false }, transient: true });
        writer.write({ type: "start" });
        writer.write({ type: "text-start", id: "a" });
        writer.write({ type: "text-delta", id: "a", delta: "Hello there." });
        writer.write({ type: "text-end", id: "a" });
        writer.write({ type: "finish" });
      },
    }));
    const response = await post({ business: "lotus", text: "hi" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const chunks = await chunksOf(response);
    expect(chunks[0]).toMatchObject({ type: "data-conversation", transient: true, data: { token: "t".repeat(43) } });
    expect(chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta).join("")).toBe("Hello there.");
    expect(web.received[0]).toEqual({ body: { business: "lotus", text: "hi" }, address: "203.0.113.9" });
  });

  it("keeps running the turn to its end when the visitor closes the page mid-answer, so it is saved and the chat let go", async () => {
    let answer!: () => void;
    const modelDone = new Promise<void>((resolve) => { answer = resolve; });
    let settled!: () => void;
    const turnSettled = new Promise<void>((resolve) => { settled = resolve; });
    web.chat.mockImplementation(() => createUIMessageStream({
      execute: async ({ writer }) => {
        writer.write({ type: "start" });
        await modelDone;
        // Stands for the turn settling: saved, then the lease let go, and the last parts written.
        writer.write({ type: "text-start", id: "a" });
        writer.write({ type: "text-delta", id: "a", delta: "Saved." });
        writer.write({ type: "text-end", id: "a" });
        writer.write({ type: "finish" });
        settled();
      },
    }));
    const response = await post({ business: "lotus", text: "hi" });
    await response.body!.cancel();
    answer();
    await expect(Promise.race([turnSettled.then(() => "settled"), new Promise((resolve) => { setTimeout(() => resolve("stuck"), 1_000); })])).resolves.toBe("settled");
  });

  it("answers anything that refuses the message with the ordinary JSON error, before streaming starts", async () => {
    web.chat.mockRejectedValue(new ApiError(409, "assistant_busy", "I'm still answering your last message. Give me a moment.", undefined, { "Retry-After": "2" }));
    const busy = await post({ business: "lotus", text: "hi" });
    expect(busy.status).toBe(409);
    expect(busy.headers.get("content-type")).toContain("application/json");
    expect(busy.headers.get("retry-after")).toBe("2");
    expect(await busy.json()).toMatchObject({ error: { code: "assistant_busy", message: "I'm still answering your last message. Give me a moment." } });

    web.chat.mockRejectedValue(new ApiError(429, "rate_limited", "Slow down a little. Wait a minute and try again.", undefined, { "Retry-After": "60" }));
    const limited = await post({ business: "lotus", text: "hi" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  it("keeps the one-of rule: one message, one tapped Confirm or one code, never two, never none", async () => {
    const none = await post({ business: "lotus" });
    expect(none.status).toBe(400);
    const two = await post({ business: "lotus", text: "yes", code: "123456" });
    expect(two.status).toBe(400);
    const bad = await post({ business: "Not A Slug", text: "hi" });
    expect(bad.status).toBe(400);
    expect(web.received).toHaveLength(0);
  });

  it("refuses a body over 8 KB before anything runs", async () => {
    const huge = await post({ business: "lotus", text: "x".repeat(9_000) });
    expect(huge.status).toBeGreaterThanOrEqual(400);
    expect(web.received).toHaveLength(0);
  });
});
