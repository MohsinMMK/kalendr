/**
 * How hard the worker tries to deliver a webhook (feature 34). One object so tests can shrink it; production uses
 * the defaults. The gaps add up to about 22 hours before a delivery is given up on.
 */
export interface WebhookPolicy {
  /** Wait before attempt 2, 3, … The number of attempts is one more than the number of gaps. */
  retryDelaysMs: readonly number[];
  /** After this many failed attempts in a row (across deliveries) the address is switched off. */
  disableAfterFailures: number;
  timeoutMs: number;
}

const minute = 60_000;
const hour = 60 * minute;

export const defaultWebhookPolicy: WebhookPolicy = {
  retryDelaysMs: [1 * minute, 5 * minute, 20 * minute, 1 * hour, 3 * hour, 6 * hour, 12 * hour],
  disableAfterFailures: 12,
  timeoutMs: 10_000,
};

export const maxAttempts = (policy: WebhookPolicy): number => policy.retryDelaysMs.length + 1;

/** Milliseconds to wait after the given (1-based) failed attempt, or null when there are no attempts left. */
export function retryDelayAfter(policy: WebhookPolicy, attempt: number): number | null {
  return policy.retryDelaysMs[attempt - 1] ?? null;
}
