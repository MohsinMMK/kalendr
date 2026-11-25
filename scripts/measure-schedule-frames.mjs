// Measures how smooth the staff schedule is on a long day, in a real (headless) Chromium.
// It scrolls, types in the search box and drags a card while recording the time between painted frames.
//
//   KALENDR_MEASURE_URL=http://localhost:3031 KALENDR_STAFF_CREDENTIALS=.e2e/staff-credentials.json \
//     node scripts/measure-schedule-frames.mjs --date 2026-11-17 --view staff
//
// Run it against a production build (`next start`) and a throwaway database filled by
// scripts/seed-schedule-load.mjs. A development server is much slower and says nothing about the product.
import { readFileSync } from "node:fs";

import { chromium } from "@playwright/test";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []));
const base = process.env.KALENDR_MEASURE_URL ?? "http://localhost:3031";
const credentialsPath = process.env.KALENDR_STAFF_CREDENTIALS ?? ".e2e/staff-credentials.json";
const email = args.email ?? "kalendr.owner@example.com";
const date = args.date ?? "2026-11-17";
const view = args.view ?? "staff";
const password = JSON.parse(readFileSync(credentialsPath, "utf8"))[email];
if (!password) throw new Error(`No password for ${email} in ${credentialsPath}.`);

const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: base, viewport: { width: 1366, height: 900 }, locale: "en-IN", timezoneId: "Asia/Kolkata" });
const page = await context.newPage();
const signIn = await page.request.post("/api/auth/sign-in/email", { data: { email, password }, headers: { origin: base } });
if (!signIn.ok()) throw new Error(`Sign-in failed (${signIn.status()}).`);
await page.goto(`/schedule?date=${date}&view=${view}`);
await page.waitForSelector(view === "list" ? "[data-row-index]" : "[data-cal-event]", { timeout: 30_000 });
await page.waitForTimeout(1500);

await page.evaluate(() => {
  window.__frames = [];
  window.__long = 0;
  let last = performance.now();
  const tick = (now) => { window.__frames.push(now - last); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  new PerformanceObserver((list) => { window.__long += list.getEntries().filter((entry) => entry.duration > 50).length; }).observe({ entryTypes: ["longtask"] });
});

async function measure(label, action) {
  await page.evaluate(() => { window.__frames.length = 0; window.__long = 0; });
  await action();
  await page.waitForTimeout(300);
  const { frames, long } = await page.evaluate(() => ({ frames: [...window.__frames], long: window.__long }));
  const sorted = [...frames].sort((a, b) => a - b);
  const at = (share) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0;
  const slow = frames.filter((time) => time > 33.4).length;
  console.log(`${label.padEnd(22)} frames ${String(frames.length).padStart(4)}  median ${at(0.5).toFixed(1)} ms  p95 ${at(0.95).toFixed(1)} ms  worst ${(sorted.at(-1) ?? 0).toFixed(1)} ms  over 33 ms: ${slow}  long tasks: ${long}`);
}

const visits = await page.evaluate(() => document.querySelectorAll("[data-cal-event], [data-row-index] [data-row-open]").length);
console.log(`${date} ${view}: ${visits} visits drawn in the page`);

if (view === "list") {
  await measure("scroll the list", async () => {
    for (let step = 0; step < 60; step += 1) { await page.mouse.move(700, 500); await page.mouse.wheel(0, 240); await page.waitForTimeout(16); }
  });
} else {
  await measure("scroll sideways", async () => {
    await page.mouse.move(800, 400);
    for (let step = 0; step < 60; step += 1) { await page.mouse.wheel(40, 0); await page.waitForTimeout(16); }
  });
  const card = page.locator("[data-cal-event]").first();
  const box = await card.boundingBox();
  if (box) {
    await measure("drag a card", async () => {
      await page.mouse.move(box.x + 12, box.y + box.height / 2);
      await page.mouse.down();
      for (let step = 1; step <= 60; step += 1) { await page.mouse.move(box.x + 12 + step * 4, box.y + box.height / 2); await page.waitForTimeout(8); }
      await page.keyboard.press("Escape");
      await page.mouse.up();
    });
  }
}
await page.keyboard.press("Escape");
await measure("type in the search", async () => {
  const search = page.getByRole("searchbox").first();
  await search.click();
  await search.pressSequentially("asha rao", { delay: 40 });
});
await browser.close();
