import { describe, expect, it } from "vitest";

import { readEmbedAppearance, readableOn } from "./appearance";
import { defaultEmbedOptions, embedSnippet } from "./builder";
import { dayInZone, emailTimesHtml, formatEmailTime } from "./email-times";
import { readEmbedBridge } from "./query";
import { conversionCalls, hasTracking, trackingSettingsSchema } from "./tracking";

describe("embed snippet", () => {
  it("writes one script with the chosen options and a mount element where one is needed", () => {
    const snippet = embedSnippet("https://app.example.com/", "lotus-dental", { ...defaultEmbedOptions, mode: "popup", service: "cleaning", theme: "dark", brand: "#1F6FEB", label: 'Book "now"' });
    expect(snippet).toContain('<div id="kalendr-booking"></div>');
    expect(snippet).toContain('src="https://app.example.com/embed.js"');
    expect(snippet).toContain('data-kalendr-business="lotus-dental"');
    expect(snippet).toContain('data-kalendr-service="cleaning"');
    expect(snippet).toContain('data-kalendr-mode="popup"');
    expect(snippet).toContain('data-kalendr-theme="dark"');
    expect(snippet).toContain('data-kalendr-brand="1f6feb"');
    expect(snippet).toContain('data-kalendr-label="Book &quot;now&quot;"');
  });

  it("needs no mount element for a floating button and leaves defaults out", () => {
    const snippet = embedSnippet("https://app.example.com", "lotus-dental", { ...defaultEmbedOptions, mode: "floating" });
    expect(snippet).not.toContain("kalendr-booking");
    expect(snippet).not.toContain("data-kalendr-theme");
    expect(snippet).not.toContain("data-kalendr-service");
  });
});

describe("embed appearance", () => {
  it("reads a theme and a six-digit colour and ignores anything else", () => {
    expect(readEmbedAppearance(new URLSearchParams("theme=dark&brand=1F6FEB"))).toEqual({ theme: "dark", brand: "#1f6feb" });
    expect(readEmbedAppearance(new URLSearchParams("theme=neon&brand=red;}body{display:none"))).toEqual({ theme: "auto", brand: null });
  });
  it("picks readable text for a colour", () => {
    expect(readableOn("#ffffff")).toBe("#111111");
    expect(readableOn("#0b1f4d")).toBe("#ffffff");
  });
});

describe("bridge parameters", () => {
  const nonce = "a".repeat(32);
  it("accepts an https parent origin and refuses a path or a bad nonce", () => {
    expect(readEmbedBridge({ embed: "1", kalendrNonce: nonce, kalendrParentOrigin: "https://www.example.com" })).toEqual({ nonce, parentOrigin: "https://www.example.com" });
    expect(readEmbedBridge({ embed: "1", kalendrNonce: nonce, kalendrParentOrigin: "https://www.example.com/page" })).toBeNull();
    expect(readEmbedBridge({ embed: "1", kalendrNonce: "short", kalendrParentOrigin: "https://www.example.com" })).toBeNull();
    expect(readEmbedBridge({ kalendrNonce: nonce, kalendrParentOrigin: "https://www.example.com" })).toBeNull();
  });
});

describe("tracking settings and conversions", () => {
  it("checks each id against its provider's shape", () => {
    expect(trackingSettingsSchema.safeParse({ googleAnalyticsId: "G-ABC123XYZ", tagManagerId: "GTM-ABC123", metaPixelId: "123456789012345", plausibleDomain: "example.com" }).success).toBe(true);
    expect(trackingSettingsSchema.safeParse({ metaPixelId: "<script>alert(1)</script>" }).success).toBe(false);
    expect(trackingSettingsSchema.safeParse({ googleAnalyticsId: "G-1'); evil('" }).success).toBe(false);
    expect(trackingSettingsSchema.safeParse({ plausibleDomain: "https://example.com/path" }).success).toBe(false);
  });
  it("reports whether any provider is on", () => {
    expect(hasTracking(null)).toBe(false);
    expect(hasTracking({ googleAnalyticsId: null, tagManagerId: null, metaPixelId: null, plausibleDomain: null })).toBe(false);
    expect(hasTracking({ googleAnalyticsId: null, tagManagerId: null, metaPixelId: "123456789", plausibleDomain: null })).toBe(true);
  });
  it("tells providers about a booking with ids only", () => {
    const calls = conversionCalls({ event: "booked", data: { appointmentId: "a1", serviceId: "s1", startsAt: "2026-12-01T10:00:00Z" } });
    expect(calls.map((call) => call.provider).sort()).toEqual(["ga", "gtm", "meta", "plausible"]);
    expect(calls.find((call) => call.provider === "meta")?.name).toBe("Schedule");
    for (const call of calls) expect(Object.keys(call.params ?? {}).sort()).toEqual(["booking_id", "service_id"]);
    expect(conversionCalls({ event: "opened", data: {} })).toEqual([]);
  });
});

describe("times for an email", () => {
  it("writes each time in the business's zone and escapes what it prints", () => {
    const at = new Date("2026-12-01T10:30:00Z");
    expect(formatEmailTime(at, "Asia/Kolkata")).toBe("Tue 1 Dec, 4:00 pm");
    expect(dayInZone(new Date("2026-12-01T20:00:00Z"), "Asia/Kolkata")).toBe("2026-12-02");
    const html = emailTimesHtml("Lotus <Dental>", "Clean & polish", [{ startsAt: at.toISOString(), label: "Tue 1 Dec, 4:00 pm", href: "https://app.example.com/book/x?time=1&date=2" }], "https://app.example.com/book/x");
    expect(html).toContain("Lotus &lt;Dental&gt;");
    expect(html).toContain("Clean &amp; polish");
    expect(html).toContain('href="https://app.example.com/book/x?time=1&amp;date=2"');
  });
});
