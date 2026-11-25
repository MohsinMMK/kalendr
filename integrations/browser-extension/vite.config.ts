import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig, type Plugin } from "vite";

import { buildManifest } from "./scripts/manifest.ts";

const root = import.meta.dirname;
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string };

/**
 * KALENDR_ORIGIN is the one Kalendr address this build may talk to: it is baked into the code and is the manifest's only
 * host permission. Without it the build is a check build for localhost and cannot be packaged for a store.
 */
const origin = (process.env.KALENDR_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");

function manifestPlugin(): Plugin {
  return {
    name: "kalendr-manifest",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "manifest.json", source: `${JSON.stringify(buildManifest({ origin, version: packageJson.version }), null, 2)}\n` });
    },
  };
}

export default defineConfig({
  root,
  base: "./",
  plugins: [manifestPlugin()],
  define: { __KALENDR_ORIGIN__: JSON.stringify(origin) },
  esbuild: { jsx: "automatic" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome116",
    // The stable names are the ones the manifest points at; everything else is hashed.
    rollupOptions: {
      input: { popup: resolve(root, "popup.html"), background: resolve(root, "src/background.ts") },
      output: { entryFileNames: (chunk) => (chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js") },
    },
    modulePreload: false,
    sourcemap: false,
  },
});
