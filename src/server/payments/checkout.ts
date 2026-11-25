import "server-only";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { getDatabase, withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents } from "@/db/schema";
import { PAYMENT_HOLD_MINUTES, type CheckoutSession, type PaymentStatus, type StartPaymentInput } from "@/lib/payments";
import { visitBalance } from "@/lib/money";

import { ApiError } from "../api-error";
import { env } from "../env";
import { resolveManageToken } from "../appointment-repository";
import { openManageToken } from "../messaging/sealed-link";
import { loadRecordKeys } from "../record-crypto";
import { requireFeature } from "../entitlements";
import { assertAppointmentVisibleHere } from "../location-scope";
import { requirePermission, type StaffContext } from "../staff-context";
import { drizzleRunner, asDate, asNumber } from "../workflows/runner";
import { loadAccountById, openCredentials, type AccountRow } from "./credentials";
import { providerFor } from "./index";
import { ProviderError } from "./types";

/** How long a staff-sent payment stays open. A booking's own checkout lasts as long as its held time. */
const LINK_ORDER_HOURS = 24 * 7;

interface OrderRow {
  id: string;
  appointmentId: string;
  accountId: string;
  amountMinor: number;
  currency: string;
  providerOrderId: string | null;
  checkoutUrl: string | null;
  expiresAt: Date | null;
  mode: "test" | "live";
}

interface AppointmentFacts {
  id: string;
  status: string;
  priceMinor: number | null;
  terms: { dueNowMinor?: number } | null;
  holdExpiresAt: Date | null;
  businessName: string;
  serviceName: string;
}

async function lockAppointment(transaction: KalendrTransaction, tenantId: string, appointmentId: string): Promise<AppointmentFacts> {
  const [row] = await transaction.execute<{ id: string; status: string; price_minor: number | null; payment_terms: { dueNowMinor?: number } | null; hold_expires_at: Date | null; business_name: string; service_name: string }>(sql`
    select appointment.id, appointment.status::text as status, appointment.price_minor, appointment.payment_terms,
      (select max(reservation.hold_expires_at) from resource_reservations as reservation
        where reservation.tenant_id = appointment.tenant_id and reservation.appointment_id = appointment.id and reservation.state = 'held') as hold_expires_at,
      tenant.name as business_name, service.name as service_name
    from appointments as appointment
    join tenants as tenant on tenant.id = appointment.tenant_id
    join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
    where appointment.tenant_id = ${tenantId} and appointment.id = ${appointmentId}
    for update of appointment`);
  if (!row) throw new ApiError(404, "booking_not_found", "That booking could not be found.");
  return { id: row.id, status: row.status, priceMinor: row.price_minor, terms: row.payment_terms, holdExpiresAt: row.hold_expires_at == null ? null : asDate(row.hold_expires_at), businessName: row.business_name, serviceName: row.service_name };
}

async function activeAccount(transaction: KalendrTransaction, tenantId: string): Promise<AccountRow> {
  const [row] = await transaction.execute<{ id: string }>(sql`select id from tenant_payment_accounts where tenant_id = ${tenantId} and status = 'active'`);
  const account = row ? await loadAccountById(drizzleRunner(transaction), tenantId, row.id) : null;
  if (!account) throw new ApiError(409, "payments_not_set_up", "Online payment isn't available for this business right now.");
  return account;
}

/** What is still to be paid on a booking that is already confirmed: its price less what has been paid and given back. */
async function balanceDue(transaction: KalendrTransaction, tenantId: string, appointmentId: string, priceMinor: number | null): Promise<number> {
  const [paid] = await transaction.execute<{ total: string }>(sql`select coalesce(sum(amount_minor), 0) as total from payments where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`);
  const [refunded] = await transaction.execute<{ total: string }>(sql`
    select coalesce(sum(r.amount_minor), 0) as total from payment_refunds r join payments p on p.tenant_id = r.tenant_id and p.id = r.payment_id
    where r.tenant_id = ${tenantId} and p.appointment_id = ${appointmentId}`);
  return visitBalance(priceMinor, asNumber(paid?.total), asNumber(refunded?.total)).dueMinor;
}

function toOrder(row: Record<string, unknown>): OrderRow {
  return {
    id: String(row.id), appointmentId: String(row.appointment_id), accountId: String(row.account_id), amountMinor: Number(row.amount_minor),
    currency: String(row.currency), providerOrderId: row.provider_order_id == null ? null : String(row.provider_order_id),
    checkoutUrl: row.checkout_url == null ? null : String(row.checkout_url), expiresAt: row.expires_at == null ? null : asDate(row.expires_at), mode: String(row.mode) as "test" | "live",
  };
}

const orderColumns = sql`id, appointment_id, account_id, amount_minor, currency, provider_order_id, checkout_url, expires_at, mode`;

function sessionFor(account: AccountRow, order: OrderRow, businessName: string, returnPath: string): CheckoutSession {
  const providerOrderId = order.providerOrderId ?? "";
  const checkoutUrl = account.provider === "fake"
    ? `/pay/test/${encodeURIComponent(providerOrderId)}?${new URLSearchParams({ returnTo: returnPath, amount: String(order.amountMinor), currency: order.currency, business: businessName })}`
    : order.checkoutUrl;
  return {
    provider: account.provider, orderId: providerOrderId, amountMinor: order.amountMinor, currency: order.currency,
    keyId: account.provider === "razorpay" ? account.keyId : null, checkoutUrl, expiresAt: (order.expiresAt ?? new Date(Date.now() + PAYMENT_HOLD_MINUTES * 60_000)).toISOString(),
    mode: account.mode, businessName,
  };
}

/**
 * Makes the checkout for a booking. The amount comes from the booking's own stored terms (worked out on the
 * server when it was made) or from what is still owed, never from the browser. Asking the provider for the order is
 * the one outside call allowed inside a request: the customer is waiting for the answer. It happens outside any database
 * transaction, so a slow provider never holds a lock.
 */
async function checkoutFor(tenantId: string, appointmentId: string, token: string, origin: string): Promise<CheckoutSession> {
  const returnPath = `/manage/${encodeURIComponent(token)}?paid=1`;
  const prepared = await withTenant(tenantId, async (transaction) => {
    await loadRecordKeys(transaction, tenantId);
    const appointment = await lockAppointment(transaction, tenantId, appointmentId);
    let amountMinor: number;
    let expiresAt: Date;
    if (appointment.status === "pending_payment") {
      if (!appointment.holdExpiresAt || appointment.holdExpiresAt.getTime() <= Date.now()) {
        throw new ApiError(409, "hold_expired", "Your held time was let go. Please pick a time again.");
      }
      amountMinor = appointment.terms?.dueNowMinor ?? 0;
      expiresAt = appointment.holdExpiresAt;
    } else if (["booked", "requested", "checked_in"].includes(appointment.status)) {
      amountMinor = await balanceDue(transaction, tenantId, appointmentId, appointment.priceMinor);
      expiresAt = new Date(Date.now() + LINK_ORDER_HOURS * 3_600_000);
    } else {
      throw new ApiError(409, "not_payable", "This booking can't be paid for any more.");
    }
    if (amountMinor <= 0) throw new ApiError(409, "nothing_due", "There is nothing to pay on this booking.");
    const account = await activeAccount(transaction, tenantId);
    const [tenant] = await transaction.execute<{ currency: string }>(sql`select currency from tenants where id = ${tenantId}`);
    const currency = tenant?.currency ?? "INR";

    // The same checkout is handed back while it is still open and for the same amount.
    const [open] = await transaction.execute(sql`select ${orderColumns} from payment_orders where tenant_id = ${tenantId} and appointment_id = ${appointmentId} and status = 'created' for update`);
    let order = open ? toOrder(open) : null;
    if (order && (order.amountMinor !== amountMinor || order.accountId !== account.id)) {
      await transaction.execute(sql`update payment_orders set status = 'expired', updated_at = now() where tenant_id = ${tenantId} and id = ${order.id}`);
      order = null;
    }
    if (!order) {
      const id = randomUUID();
      await transaction.execute(sql`
        insert into payment_orders (id, tenant_id, appointment_id, account_id, provider, mode, amount_minor, currency, expires_at)
        values (${id}, ${tenantId}, ${appointmentId}, ${account.id}, ${account.provider}, ${account.mode}, ${amountMinor}, ${currency}, ${expiresAt.toISOString()}::timestamptz)`);
      order = { id, appointmentId, accountId: account.id, amountMinor, currency, providerOrderId: null, checkoutUrl: null, expiresAt, mode: account.mode };
    }
    return { account, order, businessName: appointment.businessName, serviceName: appointment.serviceName, credentials: order.providerOrderId ? null : openCredentials(account) };
  });

  if (prepared.order.providerOrderId || !prepared.credentials) {
    return sessionFor(prepared.account, prepared.order, prepared.businessName, returnPath);
  }
  let created;
  try {
    created = await providerFor(prepared.account.provider, { stripeSecretKey: env().STRIPE_CONNECT_SECRET_KEY }).createOrder(prepared.credentials, {
      amountMinor: prepared.order.amountMinor, currency: prepared.order.currency, reference: prepared.order.id, businessName: prepared.businessName,
      returnUrl: `${origin}${returnPath}`, accountPublicId: prepared.account.publicId, description: `${prepared.serviceName} at ${prepared.businessName}`, expiresAt: prepared.order.expiresAt ?? new Date(Date.now() + PAYMENT_HOLD_MINUTES * 60_000),
    });
  } catch (error: unknown) {
    await withTenant(tenantId, (transaction) => transaction.execute(sql`update payment_orders set status = 'failed', updated_at = now() where tenant_id = ${tenantId} and id = ${prepared.order.id} and status = 'created'`));
    if (error instanceof ProviderError) throw new ApiError(502, "provider_unavailable", "We couldn't start the payment just now. Please try again in a moment.");
    throw error;
  }
  const saved = await withTenant(tenantId, async (transaction) => {
    const updated = await transaction.execute(sql`
      update payment_orders set provider_order_id = ${created.providerOrderId}, checkout_url = ${created.checkoutUrl}, updated_at = now()
      where tenant_id = ${tenantId} and id = ${prepared.order.id} and provider_order_id is null and status = 'created' returning ${orderColumns}`);
    if (updated[0]) {
      await transaction.insert(auditEvents).values({
        tenantId, appointmentId, actorType: "patient", action: "payment.checkout_started", outcome: "success",
        metadata: { orderId: prepared.order.id, provider: prepared.account.provider, amountMinor: prepared.order.amountMinor, currency: prepared.order.currency },
      });
      return toOrder(updated[0]);
    }
    // Another tab got there first: use its order. The one we just made at the provider is never paid and simply lapses.
    const [mine] = await transaction.execute(sql`select ${orderColumns} from payment_orders where tenant_id = ${tenantId} and id = ${prepared.order.id}`);
    return mine ? toOrder(mine) : prepared.order;
  });
  return sessionFor(prepared.account, saved, prepared.businessName, returnPath);
}

export async function startCheckout(input: StartPaymentInput, origin: string): Promise<CheckoutSession> {
  if (!getDatabase()) throw new ApiError(503, "database_unavailable", "Payments are not available right now.");
  const resolved = await resolveManageToken(input.manageToken);
  if (!resolved) throw new ApiError(404, "booking_not_found", "That booking could not be found.");
  return checkoutFor(resolved.tenant_id, resolved.appointment_id, input.manageToken, origin);
}

/** The "confirming…" screen's question. Only a webhook ever moves a booking out of `pending_payment`. */
export async function paymentStatus(input: StartPaymentInput): Promise<PaymentStatus> {
  const resolved = await resolveManageToken(input.manageToken);
  if (!resolved) throw new ApiError(404, "booking_not_found", "That booking could not be found.");
  return withTenant(resolved.tenant_id, async (transaction) => {
    const [row] = await transaction.execute<{ status: string; hold_expires_at: Date | null }>(sql`
      select appointment.status::text as status,
        (select max(reservation.hold_expires_at) from resource_reservations as reservation
          where reservation.tenant_id = appointment.tenant_id and reservation.appointment_id = appointment.id and reservation.state = 'held') as hold_expires_at
      from appointments as appointment where appointment.tenant_id = ${resolved.tenant_id} and appointment.id = ${resolved.appointment_id}`);
    if (!row) throw new ApiError(404, "booking_not_found", "That booking could not be found.");
    const state: PaymentStatus["state"] = row.status === "pending_payment" ? "waiting"
      : row.status === "expired" ? "expired"
        : row.status === "cancelled" || row.status === "entered_in_error" ? "cancelled" : "confirmed";
    return { state, appointmentStatus: row.status, expiresAt: row.hold_expires_at == null ? null : asDate(row.hold_expires_at).toISOString() };
  });
}

/** The staff-sent pay page `/pay/[token]`: the token is the booking's own manage token, and the amount is what is still owed. */
export async function startLinkCheckout(token: string, origin: string): Promise<CheckoutSession> {
  return startCheckout({ clinicSlug: "link", manageToken: token }, origin);
}

/** Staff: the address to send the customer so they can pay what is still owed. Calls no provider. */
export async function createPaymentLink(context: StaffContext, appointmentId: string, origin: string): Promise<{ url: string; amountMinor: number; currency: string; expiresAt: string }> {
  requirePermission(context, "payments.collect");
  requireFeature(context, "onlinePayments");
  if (context.preview) throw new ApiError(409, "preview_only", "Payment links aren't available in the preview.");
  return withTenant(context.tenantId, async (transaction) => {
    await activeAccount(transaction, context.tenantId);
    const appointment = await lockAppointment(transaction, context.tenantId, appointmentId);
    // The link opens /pay/{manage token}, which can also cancel or move the visit, so another branch's visit reads as missing.
    await assertAppointmentVisibleHere(transaction, context, appointmentId);
    if (!["booked", "requested", "checked_in"].includes(appointment.status)) throw new ApiError(409, "not_payable", "This booking can't be paid for any more.");
    const amountMinor = await balanceDue(transaction, context.tenantId, appointmentId, appointment.priceMinor);
    if (amountMinor <= 0) throw new ApiError(409, "nothing_due", "There is nothing to pay on this booking.");
    const [tenant] = await transaction.execute<{ currency: string }>(sql`select currency from tenants where id = ${context.tenantId}`);
    const [link] = await transaction.execute<{ manage_token_ciphertext: string | null }>(sql`select manage_token_ciphertext from appointments where tenant_id = ${context.tenantId} and id = ${appointmentId}`);
    const token = openManageToken(context.tenantId, appointmentId, link?.manage_token_ciphertext ?? null);
    // Bookings made before links were sealed have no recoverable token, so they cannot be sent a link.
    if (!token) throw new ApiError(409, "link_unavailable", "A payment link can't be made for this booking. Take the payment at the desk instead.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, appointmentId, actorUserId: context.userId, actorType: "staff", action: "payment.link_made", outcome: "success", metadata: { amountMinor },
    });
    return { url: `${origin}/pay/${encodeURIComponent(token)}`, amountMinor, currency: tenant?.currency ?? "INR", expiresAt: new Date(Date.now() + LINK_ORDER_HOURS * 3_600_000).toISOString() };
  });
}

export interface PayLinkView {
  state: "open" | "paid" | "expired" | "invalid";
  businessName: string | null;
  serviceName: string | null;
  startsAt: string | null;
  timezone: string | null;
  locale: string | null;
  amountMinor: number | null;
  currency: string;
  policyText: string | null;
}

/** What the pay page shows before the customer taps Pay. Only what the holder of the booking's own link may already see. */
export async function viewPayLink(token: string): Promise<PayLinkView> {
  const empty: PayLinkView = { state: "invalid", businessName: null, serviceName: null, startsAt: null, timezone: null, locale: null, amountMinor: null, currency: "INR", policyText: null };
  const resolved = await resolveManageToken(token);
  if (!resolved) return empty;
  return withTenant(resolved.tenant_id, async (transaction) => {
    const [row] = await transaction.execute<{ status: string; price_minor: number | null; terms: { dueNowMinor?: number } | null; policy: string | null; starts_at: Date; business: string; service: string; timezone: string; locale: string; currency: string; hold: Date | null }>(sql`
      select appointment.status::text as status, appointment.price_minor, appointment.payment_terms as terms, appointment.payment_terms_text as policy,
        appointment.starts_at, tenant.name as business, service.name as service, location.timezone, tenant.locale, tenant.currency,
        (select max(r.hold_expires_at) from resource_reservations r where r.tenant_id = appointment.tenant_id and r.appointment_id = appointment.id and r.state = 'held') as hold
      from appointments as appointment
      join tenants as tenant on tenant.id = appointment.tenant_id
      join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
      join locations as location on location.tenant_id = appointment.tenant_id and location.id = appointment.location_id
      where appointment.tenant_id = ${resolved.tenant_id} and appointment.id = ${resolved.appointment_id}`);
    if (!row) return empty;
    const base = { businessName: row.business, serviceName: row.service, startsAt: asDate(row.starts_at).toISOString(), timezone: row.timezone, locale: row.locale, currency: row.currency, policyText: row.policy };
    if (row.status === "expired" || row.status === "cancelled" || row.status === "entered_in_error") return { ...base, state: "expired", amountMinor: null };
    if (row.status === "pending_payment") {
      const live = row.hold != null && asDate(row.hold).getTime() > Date.now();
      return { ...base, state: live ? "open" : "expired", amountMinor: live ? row.terms?.dueNowMinor ?? null : null };
    }
    const due = await balanceDue(transaction, resolved.tenant_id, resolved.appointment_id, row.price_minor);
    return { ...base, state: due > 0 ? "open" : "paid", amountMinor: due > 0 ? due : null };
  });
}
