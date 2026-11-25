import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildManifest } from "../scripts/manifest";

const root = resolve(import.meta.dirname, "..");

describe("the manifest", () => {
  const manifest = buildManifest({ origin: "https://app.kalendr.example/anything?x=1", version: "1.2.3" });

  it("is Manifest V3 with a popup and a module worker", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.action.default_popup).toBe("popup.html");
    expect(manifest.background).toEqual({ service_worker: "background.js", type: "module" });
    expect(manifest.version).toBe("1.2.3");
  });

  it("asks for storage and one address, and nothing else", () => {
    expect(manifest.permissions).toEqual(["storage"]);
    expect(manifest.host_permissions).toEqual(["https://app.kalendr.example/*"]);
    for (const absent of ["content_scripts", "optional_permissions", "optional_host_permissions", "web_accessible_resources", "externally_connectable", "commands"]) {
      expect(manifest).not.toHaveProperty(absent);
    }
  });

  it("has a strict page policy with no remote code", () => {
    expect(manifest.content_security_policy.extension_pages).toBe("script-src 'self'; object-src 'self'; base-uri 'none'");
  });

  it("points at icons that exist", () => {
    for (const path of Object.values(manifest.icons)) expect(existsSync(resolve(root, "public", path)), path).toBe(true);
  });

  it("keeps remote code out of the source", () => {
    const files = readdirSync(resolve(root, "src"), { recursive: true, encoding: "utf8" }).filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx"));
    for (const file of files) {
      const source = readFileSync(resolve(root, "src", file), "utf8");
      expect(source, file).not.toMatch(/\beval\(|new Function\(|chrome\.(tabs|cookies|scripting|webRequest|identity|history)/);
      expect(source, file).not.toMatch(/https?:\/\/(?!localhost)[a-z0-9.-]+\.(com|net|org|io)\b/i);
    }
  });
});
