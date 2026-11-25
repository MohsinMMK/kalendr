import { describe } from "vitest";

/**
 * Integration tests run only against a throwaway local database, never a real one. The shared ports are the
 * project's own (5544, 5545); a builder who starts a scratch server on another port names it in
 * KALENDR_TEST_SCRATCH_PORT. The host must be this machine either way.
 */
export function isScratchDatabase(url: string | undefined): boolean {
  if (!url) return false;
  const parsed = new URL(url);
  const ports = new Set(["5544", "5545", process.env.KALENDR_TEST_SCRATCH_PORT ?? ""]);
  ports.delete("");
  return ["127.0.0.1", "localhost"].includes(parsed.hostname) && ports.has(parsed.port) && /^\/(kalendr_local|nira_local|kalendr_e2e)$/.test(parsed.pathname);
}

export const describeScratch = isScratchDatabase(process.env.DATABASE_URL)
  && isScratchDatabase(process.env.KALENDR_TEST_OWNER_URL)
  && process.env.KALENDR_PREVIEW_MODE === "false"
  ? describe
  : describe.skip;
