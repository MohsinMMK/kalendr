import { tool } from "ai";
import type { z } from "zod";

import type { ToolResult } from "./context";

/**
 * Turns one of this app's tools into an AI SDK tool (feature 30). Every tool here already returns a `ToolResult` and never throws, so
 * the adapter keeps that: the tool's output is the same JSON the model has always seen, and a failure is `{ error: "..." }` that the
 * model receives as an error result (the AI SDK's `error-json` output, which Anthropic gets as `is_error`).
 *
 * The public assistant and the staff copilot both build their tools with this, so a tool means the same to the model in both.
 */

export type ToolOutput = Record<string, unknown>;

/** True for the output of `fail(...)`: a single `error` text. */
export function isFailureOutput(output: unknown): output is { error: string } {
  return typeof output === "object" && output !== null && "error" in output && typeof output.error === "string";
}

/** The tool's JSON text as an object. A result that is not an object (it always is) is wrapped rather than guessed at. */
function outputOf(result: ToolResult): ToolOutput {
  try {
    const parsed: unknown = JSON.parse(result.text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return Object.fromEntries(Object.entries(parsed));
    return { value: parsed };
  } catch {
    return result.isError ? { error: "That didn't work." } : { value: result.text };
  }
}

export function aiTool<SCHEMA extends z.ZodType>(spec: {
  description: string;
  inputSchema: SCHEMA;
  /** Runs the tool. Must not throw; failures are `fail(...)` results. */
  run: (input: z.infer<SCHEMA>, details: { toolCallId: string }) => Promise<ToolResult>;
}) {
  return tool({
    description: spec.description,
    inputSchema: spec.inputSchema,
    execute: async (input: z.infer<SCHEMA>, options: { toolCallId: string }): Promise<ToolOutput> => outputOf(await spec.run(input, { toolCallId: options.toolCallId })),
    toModelOutput: ({ output }) => (isFailureOutput(output) ? { type: "error-json", value: output } : { type: "json", value: output as never }),
  });
}
