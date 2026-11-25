import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The import code reduces every row problem to a fixed code and never logs. This reads the source to keep it that way: no
 * console call and no logger anywhere in the import server code, its routes or its worker handler.
 */

const roots = ["src/server/imports", "src/app/api/staff/imports", "src/worker/handlers/import.ts", "src/worker/import-jobs.ts"];

function sources(target: string): string[] {
  const full = path.resolve(process.cwd(), target);
  if (full.endsWith(".ts")) return [full];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(full, entry.name);
    if (entry.isDirectory()) return entry.name === "testing" ? [] : sources(path.relative(process.cwd(), child));
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [child] : [];
  });
}

describe("import code never logs", () => {
  const files = roots.flatMap(sources);

  it("found the files", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it.each(files.map((file) => [path.relative(process.cwd(), file), file]))("%s", (_name, file) => {
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/\bconsole\./);
    expect(text).not.toMatch(/createLogger|from "@\/server\/logger"|from "\.\.?\/.*logger"|errorSummary/);
  });
});
