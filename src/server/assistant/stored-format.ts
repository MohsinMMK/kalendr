import { z } from "zod";

/**
 * How one assistant message is kept in the sealed `content_ciphertext` column (feature 30).
 *
 * Format 1 (every chat before the AI SDK move) is a JSON array of model blocks. Format 2 is `{ "format": 2, "message": <UI message> }`,
 * the AI SDK message exactly as the page shows it: text, tool steps and the booking proposal. The two can sit in one chat, and the
 * shape tells them apart, so no column or migration is needed. This file has no server-only imports: the privacy export reads it too.
 */

const storedUiMessageSchema = z.object({
  id: z.string().min(1).max(64),
  role: z.enum(["user", "assistant"]),
  parts: z.array(z.record(z.string(), z.unknown())),
});
export type StoredUiMessage = z.infer<typeof storedUiMessageSchema>;

const storedUiEnvelopeSchema = z.object({ format: z.literal(2), message: storedUiMessageSchema });

export function encodeUiMessage(message: StoredUiMessage): string {
  return JSON.stringify({ format: 2, message: { id: message.id, role: message.role, parts: message.parts } });
}

export function readUiEnvelope(parsed: unknown): StoredUiMessage | null {
  const result = storedUiEnvelopeSchema.safeParse(parsed);
  return result.success ? result.data.message : null;
}

/** The words in a list of UI message parts, in order. Tool steps, reasoning and data parts carry no words of their own. */
export function textOfUiParts(parts: readonly Record<string, unknown>[]): string {
  return parts.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n").trim();
}

/** The words in any stored message, whichever format it is in. Used by the privacy export, which must not choke on either. */
export function textOfStoredContent(parsed: unknown): string {
  const envelope = readUiEnvelope(parsed);
  if (envelope) return textOfUiParts(envelope.parts);
  if (!Array.isArray(parsed)) return "";
  return parsed
    .flatMap((block: unknown) => (typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" ? [block.text] : []))
    .join(" ");
}
