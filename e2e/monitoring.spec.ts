import { expect, test } from "@playwright/test";

const captureUrl = process.env.KALENDR_CAPTURE_URL ?? "http://127.0.0.1:3199";

test("health and readiness answer, and error reports carry a request id and no personal data", async ({ request }) => {
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);

  const ready = await request.get("/api/ready");
  expect(ready.status()).toBe(200);
  expect(await ready.json()).toMatchObject({ status: "ready", checks: { database: "ok", migrations: "ok" } });

  // Every error the app has reported to the stand-in Sentry so far in this run.
  const events = (await (await fetch(`${captureUrl}/errors`)).json()) as Array<Record<string, unknown>>;
  for (const event of events) {
    const text = JSON.stringify(event);
    expect((event.tags as Record<string, string> | undefined)?.request_id, "every error report names its request").toBeTruthy();
    expect(text).not.toMatch(/[\w.+-]+@example\.com/);
    expect(text).not.toMatch(/\+91[\s\d]{10,}/);
  }
});
