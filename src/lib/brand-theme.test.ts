import { describe, expect, it } from "vitest";

import { brandStyle, contrastRatio, defaultBrand, emailAccent, parseBrand, readAccent } from "./brand-theme";

describe("brand theme", () => {
  it("gives a yellow accent dark text on its own and tells the owner", () => {
    const reading = readAccent("#f5b800");
    expect(reading.usesDarkText).toBe(true);
    expect(reading.text).toBe("#000000");
    expect(reading.ratio).toBeGreaterThanOrEqual(4.5);
    expect(reading.notes.join(" ")).toMatch(/dark text/);
  });

  it("keeps white text on a dark accent and says nothing", () => {
    const reading = readAccent("#1e3a8a");
    expect(reading.usesDarkText).toBe(false);
    expect(reading.text).toBe("#ffffff");
    expect(reading.notes).toEqual([]);
  });

  it("reaches at least 4.5 to 1 for every accent on a coarse colour sweep", () => {
    for (let red = 0; red <= 255; red += 51) {
      for (let green = 0; green <= 255; green += 51) {
        for (let blue = 0; blue <= 255; blue += 51) {
          const accent = `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
          expect(readAccent(accent).ratio, accent).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("measures contrast on the WCAG scale", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
  });

  it("warns about an accent too pale to show as a line", () => {
    expect(readAccent("#fafafa").notes.join(" ")).toMatch(/very pale/);
  });

  it("cleans a stored brand field by field", () => {
    expect(parseBrand({ accent: "javascript:alert(1)", corners: "round", hideBadge: true })).toEqual({ accent: null, corners: "round", hideBadge: true });
    expect(parseBrand({ accent: "#ABCDEF", corners: "diamond", hideBadge: "yes" })).toEqual({ accent: "#abcdef", corners: "soft", hideBadge: false });
    expect(parseBrand(null)).toEqual(defaultBrand);
    expect(parseBrand([1, 2])).toEqual(defaultBrand);
  });

  it("turns the accent into the coss variables with readable foreground, and leaves Kalendr's colours alone without one", () => {
    const yellow = brandStyle({ accent: "#f5b800", corners: "square", hideBadge: false });
    expect(yellow["--primary"]).toBe("#f5b800");
    expect(yellow["--primary-foreground"]).toBe("#000000");
    expect(yellow["--radius"]).toBe("0.25rem");
    const none = brandStyle(defaultBrand);
    expect(none).toEqual({ "--radius": "0.625rem" });
  });

  it("uses the product colour in emails when the business has none", () => {
    expect(emailAccent(defaultBrand, "#0f766e")).toEqual({ accent: "#0f766e", text: "#ffffff" });
    expect(emailAccent({ ...defaultBrand, accent: "#f5b800" }, "#0f766e").text).toBe("#000000");
  });
});
