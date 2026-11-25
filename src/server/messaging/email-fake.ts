/**
 * An email provider for tests. It keeps what it was given in memory, answers a repeated
 * idempotency key with the first message's id (as Resend does), and can be told to fail.
 */
import { PermanentSendError, TransientSendError, type MessageProvider, type RenderedMessage } from "./provider";

export interface FakeEmailProvider extends MessageProvider {
  /** Every distinct message accepted, in order. A repeat of an idempotency key is not added again. */
  readonly sent: RenderedMessage[];
  /** Every call to send, including repeats and failures. */
  readonly attempts: number;
  /** The next calls fail this way, one entry per call. */
  failNext(...failures: Array<"transient" | "permanent">): void;
  reset(): void;
}

/**
 * `idPrefix` names the ids it hands out (`<prefix>-1`, `<prefix>-2`, …). Tests that share a database and look a message
 * up by its id (the delivery webhooks) give it a unique prefix, so another test's `fake-email-1` is never theirs.
 */
export function createFakeEmailProvider({ idPrefix = "fake-email" }: { idPrefix?: string } = {}): FakeEmailProvider {
  const sent: RenderedMessage[] = [];
  const ids = new Map<string, string>();
  let failures: Array<"transient" | "permanent"> = [];
  let attempts = 0;
  return {
    channel: "email",
    sent,
    get attempts() {
      return attempts;
    },
    failNext(...next) {
      failures.push(...next);
    },
    reset() {
      sent.length = 0;
      ids.clear();
      failures = [];
      attempts = 0;
    },
    async send(message) {
      attempts += 1;
      const failure = failures.shift();
      if (failure === "transient") throw new TransientSendError("fake_unavailable");
      if (failure === "permanent") throw new PermanentSendError("fake_refused");
      const known = ids.get(message.idempotencyKey);
      if (known) return { providerMessageId: known };
      const id = `${idPrefix}-${sent.length + 1}`;
      ids.set(message.idempotencyKey, id);
      sent.push(message);
      return { providerMessageId: id };
    },
  };
}
