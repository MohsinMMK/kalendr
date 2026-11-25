/**
 * A channel that keeps what it was given in memory, for tests and for local runs where no
 * provider account exists. It answers a repeated idempotency key with the first message's id,
 * and can be told to fail. Nothing leaves the machine.
 */
import { randomUUID } from "node:crypto";

import {
  emptyWebhook,
  type Channel,
  type ChannelId,
  type ChannelMessage,
  type ParsedWebhook,
  type SendResult,
} from "./types";

export interface CaptureChannel extends Channel {
  /** Every distinct message accepted, in order. */
  readonly sent: ChannelMessage[];
  /** Every call to send, including repeats and failures. */
  readonly attempts: number;
  failNext(...failures: Array<"retry" | "rejected">): void;
  /** Parsed by parseWebhook instead of reading a signed body. Tests set this. */
  nextWebhook(parsed: ParsedWebhook): void;
  reset(): void;
}

export function createCaptureChannel(id: ChannelId): CaptureChannel {
  const sent: ChannelMessage[] = [];
  const ids = new Map<string, string>();
  // Unique per channel instance so ids from two test runs never collide in a shared database.
  const run = randomUUID().slice(0, 8);
  let failures: Array<"retry" | "rejected"> = [];
  let attempts = 0;
  let webhook: ParsedWebhook = emptyWebhook;
  return {
    id,
    mode: "capture",
    sent,
    get attempts() {
      return attempts;
    },
    failNext(...next) {
      failures.push(...next);
    },
    nextWebhook(parsed) {
      webhook = parsed;
    },
    reset() {
      sent.length = 0;
      ids.clear();
      failures = [];
      attempts = 0;
      webhook = emptyWebhook;
    },
    async send(message): Promise<SendResult> {
      attempts += 1;
      const failure = failures.shift();
      if (failure === "retry") return { status: "retry", code: "capture_unavailable" };
      if (failure === "rejected") return { status: "rejected", code: "capture_refused" };
      const known = ids.get(message.idempotencyKey);
      if (known) return { status: "sent", providerMessageId: known };
      const providerMessageId = `capture-${id}-${run}-${sent.length + 1}`;
      ids.set(message.idempotencyKey, providerMessageId);
      sent.push(message);
      return { status: "sent", providerMessageId, costCategory: id === "whatsapp" ? "utility" : undefined };
    },
    parseWebhook() {
      return webhook;
    },
  };
}
