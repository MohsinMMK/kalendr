import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import DevelopersPage from "@/app/developers/page";
import { apiOperations } from "@/server/openapi-operations";
import { webhookEvents } from "@/server/openapi-webhooks";

describe("the /developers reference", () => {
  const html = renderToStaticMarkup(<DevelopersPage />);

  it("lists every operation with its path and scope, and a table of contents entry", () => {
    for (const operation of apiOperations) {
      expect(html).toContain(`id="op-${operation.id}"`);
      expect(html).toContain(`href="#op-${operation.id}"`);
      expect(html).toContain(operation.path);
      expect(html).toContain(operation.scope);
    }
  });

  it("documents webhooks, the signature check in two languages, and the curl quick start", () => {
    for (const event of webhookEvents) expect(html).toContain(event.type);
    expect(html).toContain("X-Kalendr-Signature");
    expect(html).toContain("timingSafeEqual");
    expect(html).toContain("compare_digest");
    expect(html).toContain("curl");
    expect(html).toContain("Idempotency-Key");
    expect(html).toContain("Retry-After");
  });

  it("loads no outside script", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\/(?!localhost|example|your)[^"' ]*\.(js|css)/i);
  });
});
