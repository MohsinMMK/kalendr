/**
 * The pure rules behind the customer sign-in upgrade (feature 8): how long to wait after a wrong code, how long a session
 * lasts, when a manage link stops working, and whether a change through a manage link needs a one-time code. No database
 * and no clock of their own, so each one is a plain unit test.
 */

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Seconds the next try is refused after the n-th wrong code: 2, 4, 8, 16, then 30. */
export function wrongCodeDelaySeconds(wrongAttempts: number): number {
  if (wrongAttempts <= 0) return 0;
  return Math.min(30, 2 ** Math.min(wrongAttempts, 5));
}

/** A browser session lasts a day; with "remember this device" it lasts 30. */
export function patientSessionLifetimeMs(remember: boolean): number {
  return (remember ? 30 : 1) * DAY_MS;
}

export const manageLinkGraceDays = 30;

/** A manage link works until this long after the visit ends. */
export function manageLinkExpiry(endsAt: Date): Date {
  return new Date(endsAt.getTime() + manageLinkGraceDays * DAY_MS);
}

export function manageLinkExpired(endsAt: Date, now: Date): boolean {
  return manageLinkExpiry(endsAt).getTime() <= now.getTime();
}

export type StepUpAction = "cancel" | "reschedule" | "contact";

export interface StepUpFacts {
  /** The person has typed a one-time code for this booking in the last few minutes, on this device. */
  hasGrant: boolean;
  /** This device holds a portal session that belongs to this booking's customer (not just any account). */
  portalSessionForCustomer: boolean;
  /** Money has been taken for the booking. A paid booking always asks for a code. */
  paid: boolean;
}

/**
 * Whether the change may go ahead without asking for a code. Viewing never reaches this rule. A paid booking ignores
 * the portal session, so a forwarded link and a signed-in device both have to prove the code.
 */
export function stepUpSatisfied(facts: StepUpFacts): boolean {
  if (facts.paid) return facts.hasGrant;
  return facts.hasGrant || facts.portalSessionForCustomer;
}

export const stepUpCodeLifetimeMs = 10 * 60 * 1_000;
export const stepUpGrantLifetimeMs = 15 * 60 * 1_000;
export const stepUpMaxAttempts = 5;
