import { z } from "zod";

/** Outbox event names the app framework owns (feature 55). */
export const APP_DELIVER_EVENT = "app.deliver";
export const APP_CHECK_EVENT = "app.check";
export const APP_REMOVE_EVENT = "app.remove";

/** A delivery the worker makes to one installed app. `source` is the payload of the booking event that caused it. */
export const appDeliverPayload = z.object({
  installId: z.string().min(1),
  type: z.string().min(1),
  aggregateId: z.string().min(1),
  source: z.json(),
  attempt: z.number().int().min(1),
});
export type AppDeliverPayload = z.infer<typeof appDeliverPayload>;

export const appInstallPayload = z.object({ installId: z.string().min(1) });

/** After this many failed attempts in a row, across events, an app is switched off and the owner sees why. */
export const APP_DISABLE_AFTER_FAILURES = 15;
/** Wait before attempt 2, 3, ... A delivery is given up after the last one. */
export const APP_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
