import { isPlanKey } from "../../lib/billing-rules";
import type { PlanKey, SubscriptionStatus } from "../../lib/entitlements";
import type { SubscriptionRecord } from "./entitlement-loader";
import type { BillingEventExtract } from "./webhook-events";

/**
 * From one verified provider event to what changes on the business's subscription. Pure: it reads the stored
 * subscription and the event's allow-listed extract and returns a patch, an invoice to issue and emails to queue.
 * The worker (handlers/billing.ts) does the reading and writing. The mapping below is a table, one line per event type.
 *
 * Dunning rule: `pastDueSince` is set on the FIRST failure and left alone by later ones, then cleared by a charge.
 * Setting it on every retry would push the end of the 7-day grace period out each time.
 * Events are applied as they arrive; neither provider promises order, so each patch only carries state the event
 * itself states. Known limit: see docs/subscription-billing.md.
 */

export interface SubscriptionPatch {
  planKey?: PlanKey;
  status?: SubscriptionStatus;
  provider?: "razorpay" | "stripe";
  providerCustomerId?: string;
  providerSubscriptionId?: string;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  cancelAtPeriodEnd?: boolean;
  pendingPlanKey?: PlanKey | null;
  pastDueSince?: Date | null;
}

export interface InvoiceToIssue {
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
  planKey: PlanKey;
  periodStart: Date | null;
  periodEnd: Date | null;
}

export type BillingEmail = "payment_failed" | "subscription_started";

export interface ApplyResult {
  outcome: "applied" | "ignored";
  patch: SubscriptionPatch;
  invoice: InvoiceToIssue | null;
  emails: BillingEmail[];
}

export interface ApplyInput {
  event: BillingEventExtract;
  current: SubscriptionRecord;
  now: Date;
  /** Maps a provider's plan or price id to a plan key. Notes carry the key too; this covers events that do not. */
  planForProviderId: (provider: "razorpay" | "stripe", providerPlanId: string) => PlanKey | null;
}

type Handler = (input: ApplyInput, plan: PlanKey | null) => ApplyResult;

const ignored: ApplyResult = { outcome: "ignored", patch: {}, invoice: null, emails: [] };
const date = (value: string | null): Date | undefined => (value ? new Date(value) : undefined);

function ids(event: BillingEventExtract): SubscriptionPatch {
  return {
    provider: event.provider,
    ...(event.providerSubscriptionId ? { providerSubscriptionId: event.providerSubscriptionId } : {}),
    ...(event.providerCustomerId ? { providerCustomerId: event.providerCustomerId } : {}),
  };
}

function periods(event: BillingEventExtract): SubscriptionPatch {
  const start = date(event.periodStart);
  const end = date(event.periodEnd);
  return { ...(start ? { currentPeriodStart: start } : {}), ...(end ? { currentPeriodEnd: end } : {}) };
}

/**
 * A plan change recorded as pending (a downgrade) takes effect when the paid period is over, not when the provider
 * reports the new price. Stripe reports the lower price at once; the business keeps what it paid for until the period ends.
 */
function planPatch(input: ApplyInput, plan: PlanKey | null): SubscriptionPatch {
  if (!plan) return {};
  const { current, now } = input;
  if (current.pendingPlanKey && plan === current.pendingPlanKey) {
    const periodOver = !current.currentPeriodEnd || now >= current.currentPeriodEnd;
    return periodOver ? { planKey: plan, pendingPlanKey: null } : {};
  }
  return { planKey: plan, ...(current.pendingPlanKey === plan ? { pendingPlanKey: null } : {}) };
}

const wasPaying = (status: SubscriptionStatus): boolean => status === "active" || status === "past_due" || status === "paused";

function activate(input: ApplyInput, plan: PlanKey | null, extra: SubscriptionPatch = {}): ApplyResult {
  const { event, current } = input;
  const started = !wasPaying(current.status) || current.providerSubscriptionId === null;
  return {
    outcome: "applied",
    patch: { ...ids(event), ...periods(event), ...planPatch(input, plan), status: "active", pastDueSince: null, ...extra },
    invoice: null,
    emails: started ? ["subscription_started"] : [],
  };
}

function fail(input: ApplyInput): ApplyResult {
  const { current, now } = input;
  return {
    outcome: "applied",
    patch: { ...ids(input.event), status: "past_due", pastDueSince: current.status === "past_due" && current.pastDueSince ? current.pastDueSince : now },
    invoice: null,
    emails: ["payment_failed"],
  };
}

function charged(input: ApplyInput, plan: PlanKey | null): ApplyResult {
  const { event, current } = input;
  const applied = activate(input, plan);
  const effectivePlan = applied.patch.planKey ?? current.planKey;
  // A charge always clears dunning; the invoice is for exactly what was charged, once per provider payment id.
  const invoice: InvoiceToIssue | null = event.providerPaymentId && event.amountMinor && event.amountMinor > 0 && event.currency
    ? { providerPaymentId: event.providerPaymentId, amountMinor: event.amountMinor, currency: event.currency, planKey: effectivePlan, periodStart: date(event.periodStart) ?? null, periodEnd: date(event.periodEnd) ?? null }
    : null;
  return { ...applied, invoice };
}

function setStatus(status: SubscriptionStatus, extra: SubscriptionPatch = {}): Handler {
  return (input) => ({ outcome: "applied", patch: { ...ids(input.event), ...periods(input.event), status, ...extra }, invoice: null, emails: [] });
}

const stripeStatuses: Record<string, SubscriptionStatus | null> = {
  active: "active", trialing: "active", past_due: "past_due", unpaid: "past_due", canceled: "cancelled", paused: "paused",
  incomplete: null, incomplete_expired: null,
};

function stripeSubscription(input: ApplyInput, plan: PlanKey | null): ApplyResult {
  const status = stripeStatuses[input.event.status ?? ""] ?? null;
  if (!status) return ignored;
  const cancelAtPeriodEnd = input.event.cancelAtPeriodEnd ?? input.current.cancelAtPeriodEnd;
  if (status === "past_due") {
    // The failed invoice's own event sends the email; this one only keeps the status and period current.
    const failed = fail(input);
    return { ...failed, patch: { ...failed.patch, ...periods(input.event), cancelAtPeriodEnd }, emails: [] };
  }
  if (status === "active") return activate(input, plan, { cancelAtPeriodEnd });
  return setStatus(status, { cancelAtPeriodEnd: false, ...planPatch(input, plan) })(input, plan);
}

/** One line per event type the platform acts on. Anything not here is recorded and marked ignored. */
const handlers: Record<string, Handler> = {
  // Razorpay
  "subscription.activated": (input, plan) => activate(input, plan),
  "subscription.charged": charged,
  "subscription.pending": (input) => fail(input),
  "subscription.halted": (input) => fail(input),
  "payment.failed": (input) => (input.event.providerSubscriptionId ? fail(input) : ignored),
  "subscription.paused": setStatus("paused"),
  "subscription.resumed": (input, plan) => activate(input, plan),
  "subscription.cancelled": setStatus("cancelled", { cancelAtPeriodEnd: false, pendingPlanKey: null }),
  "subscription.completed": setStatus("cancelled", { cancelAtPeriodEnd: false, pendingPlanKey: null }),
  // Stripe
  "checkout.session.completed": (input, plan) => (input.event.providerSubscriptionId ? activate(input, plan) : ignored),
  "customer.subscription.created": stripeSubscription,
  "customer.subscription.updated": stripeSubscription,
  "customer.subscription.deleted": setStatus("cancelled", { cancelAtPeriodEnd: false, pendingPlanKey: null }),
  "invoice.paid": (input, plan) => (input.event.providerSubscriptionId ? charged(input, plan) : ignored),
  "invoice.payment_failed": (input) => (input.event.providerSubscriptionId ? fail(input) : ignored),
};

export const handledEventTypes: readonly string[] = Object.keys(handlers);

export function applyBillingEvent(input: ApplyInput): ApplyResult {
  const handler = handlers[input.event.type];
  if (!handler) return ignored;
  const { event } = input;
  const fromNotes = event.planKey && isPlanKey(event.planKey) && event.planKey !== "free" ? event.planKey : null;
  const plan = event.providerPlanId ? input.planForProviderId(event.provider, event.providerPlanId) ?? fromNotes : fromNotes;
  return handler(input, plan);
}
