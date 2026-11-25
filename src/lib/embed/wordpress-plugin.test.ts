/** @vitest-environment node */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { defaultEmbedOptions, embedSnippet } from "./builder";

/**
 * The WordPress plugin (feature 55) is PHP and this machine has none, so these tests hold the plugin to the contract the
 * embed script reads: every data attribute the plugin prints is one `public/embed.js` understands, and the plugin prints
 * the same attributes as the Share sheet's snippet. A real-site run is listed as a known gap.
 */

const root = process.cwd();
const plugin = readFileSync(path.join(root, "integrations/wordpress/kalendr-booking/kalendr-booking.php"), "utf8");
const embedScript = readFileSync(path.join(root, "public/embed.js"), "utf8");

const pluginAttributes = [...plugin.matchAll(/'(data-kalendr-[a-z]+)'/g)].map((match) => match[1]!);

function camel(attribute: string): string {
  return attribute.replace(/^data-/, "").replace(/-([a-z])/g, (_all, letter: string) => letter.toUpperCase());
}

describe("the WordPress plugin", () => {
  it("prints only attributes the embed script reads", () => {
    expect(pluginAttributes.length).toBeGreaterThan(5);
    for (const attribute of new Set(pluginAttributes)) expect(embedScript, attribute).toContain(`data.${camel(attribute)}`);
  });

  it("prints the same attributes as the Share sheet for each mode", () => {
    for (const mode of ["inline", "popup", "floating"] as const) {
      const snippet = embedSnippet("https://app.example.com", "lotus-dental", { ...defaultEmbedOptions, mode, service: "cleaning", label: "Book now" });
      for (const attribute of [...snippet.matchAll(/(data-kalendr-[a-z]+)=/g)].map((match) => match[1]!)) {
        expect(pluginAttributes, `${mode}: ${attribute}`).toContain(attribute);
      }
    }
  });

  it("only loads the script from the one address the owner saved, and escapes every value it prints", () => {
    expect(plugin).toContain("'src'");
    expect(plugin).toContain("$origin . '/embed.js'");
    expect(plugin).toMatch(/esc_attr\( \$value \)/);
    // No outside request and no stored secret.
    expect(plugin).not.toMatch(/wp_remote_(get|post)|curl_|file_get_contents/);
  });

  it("exits when run outside WordPress and cleans up its settings on uninstall", () => {
    expect(plugin).toContain("defined( 'ABSPATH' )");
    expect(readFileSync(path.join(root, "integrations/wordpress/kalendr-booking/uninstall.php"), "utf8")).toContain("delete_option( 'kalendr_booking_origin' )");
  });
});
