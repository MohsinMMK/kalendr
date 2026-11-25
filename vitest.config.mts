import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const alias = {
  "@": path.resolve(projectRoot, "src"),
  "server-only": path.resolve(projectRoot, "src/test/server-only.ts"),
};

const roots = ["src", "packages", "integrations"];
const sharedTest = {
  testTimeout: 15_000,
  clearMocks: true,
};

export default defineConfig({
  test: {
    // Bound jsdom concurrency on shared developer machines.
    maxWorkers: 2,
    // Worker threads start faster than forked processes, which matters with a jsdom per file.
    pool: "threads",
    projects: [
      {
        // Component and DOM tests: jsdom plus the DOM stubs.
        resolve: { alias },
        test: {
          ...sharedTest,
          name: "jsdom",
          environment: "jsdom",
          setupFiles: ["./src/test/setup.ts"],
          include: roots.map((root) => `${root}/**/*.test.tsx`),
        },
      },
      {
        // Plain .ts tests (server, lib) need no DOM. A .ts test that does can opt in with `// @vitest-environment jsdom`.
        resolve: { alias },
        test: {
          ...sharedTest,
          name: "node",
          environment: "node",
          include: roots.map((root) => `${root}/**/*.test.ts`),
        },
      },
    ],
  },
});
