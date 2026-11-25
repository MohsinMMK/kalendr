import * as webpush from "web-push";

import type { PushMessage, StoredSubscription } from "../lib/staff-alerts";

/** What happened to one push. "gone" means the push service says this address no longer exists. */
export type PushResult = "sent" | "gone" | "retry" | "failed";

/** Sends one push. A fake stands in for it in tests, and local runs never reach a push service. */
export interface PushSender {
  readonly mode: "production" | "local_capture";
  send(subscription: StoredSubscription, message: PushMessage): Promise<PushResult>;
}

export interface VapidSettings {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** A push is worth sending for a day at most: a "new booking" alert that late is noise. */
const TTL_SECONDS = 24 * 60 * 60;

export function webPushSender(vapid: VapidSettings): PushSender {
  return {
    mode: "production",
    async send(subscription, message) {
      try {
        await webpush.sendNotification(subscription, JSON.stringify(message), {
          // Passed per call rather than set globally, so nothing else in the process can use the key.
          vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
          TTL: TTL_SECONDS,
          urgency: "normal",
          timeout: 10_000,
        });
        return "sent";
      } catch (error: unknown) {
        return resultForStatus(error instanceof webpush.WebPushError ? error.statusCode : undefined);
      }
    },
  };
}

/** 404 and 410 mean the browser unsubscribed; 429 and 5xx or no answer are worth another try; the rest never will work. */
export function resultForStatus(status: number | undefined): PushResult {
  if (status === 404 || status === 410) return "gone";
  if (status === undefined || status === 429 || status >= 500) return "retry";
  return "failed";
}

/** Local runs: pretend to send, so a developer's worker can never reach a real push service. */
export const localCapturePushSender: PushSender = {
  mode: "local_capture",
  async send() {
    return "sent";
  },
};
