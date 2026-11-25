// Bundles the two non-web entry points into single files for the container image, so the
// runtime stage needs no TypeScript tooling and no development dependencies:
//   dist/worker.mjs   the outbox worker (src/worker/run.ts)
//   dist/migrate.mjs  the release migration step (scripts/migrate.mjs)
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { build } from "esbuild";

/**
 * The invoice PDF engine (feature 24) loads its 14 built-in fonts with a run-time `require("#standard-fonts/Helvetica")` that a bundle
 * cannot find. This turns each of those into a static import of the same file, so the worker needs no node_modules.
 */
const pdfStandardFonts = {
  name: "pdfkit-standard-fonts",
  setup(esbuildBuild) {
    esbuildBuild.onLoad({ filter: /pdfkit[\\/]js[\\/]pdfkit\.node\.mjs$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      const fontsDir = join(dirname(args.path), "standard-fonts");
      const names = readdirSync(fontsDir).filter((file) => file.endsWith(".cjs")).map((file) => file.slice(0, -4));
      const imports = names.map((name) => `import __standardFont_${name} from ${JSON.stringify(join(fontsDir, `${name}.cjs`))};`).join("\n");
      const rewritten = source.replace(/require\$1\(["']#standard-fonts\/(\w+)["']\)/g, (_match, name) => `__standardFont_${name}`);
      return { contents: `${imports}\n${rewritten}`, loader: "js" };
    });
  },
};

const shared = {
  plugins: [pdfStandardFonts],
  bundle: true,
  platform: "node",
  target: "node26",
  format: "esm",
  sourcemap: true,
  tsconfig: "tsconfig.json",
  // The appointment import runs the web app's booking code in the worker. Next.js supplies the "server-only" marker; here it is empty.
  alias: { "server-only": "./src/test/server-only.ts" },
  logLevel: "warning",
  // Some bundled CommonJS packages call require(); give the ES module one.
  banner: { js: "import { createRequire as __kalendrRequire } from 'node:module'; const require = __kalendrRequire(import.meta.url);" },
};

await build({ ...shared, entryPoints: ["src/worker/run.ts"], outfile: "dist/worker.mjs" });
await build({ ...shared, entryPoints: ["scripts/migrate.mjs"], outfile: "dist/migrate.mjs" });
console.log("Built dist/worker.mjs and dist/migrate.mjs");
