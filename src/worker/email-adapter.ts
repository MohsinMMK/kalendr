/**
 * The worker's email adapter: turns one outbox message into one branded email and hands it to
 * the email provider (Resend in production, the fake or the capture server in tests).
 *
 * It reads the recipient and the booking itself, inside the business's row-level security
 * scope, checks the suppression list first, attaches the calendar file and the customer's
 * private manage link, and uses the message's semantic key as the provider's idempotency key,
 * so a retry after a timeout can never send the same email twice.
 *
 * Nothing here logs. Codes it returns are short and never hold an address, a name or a body.
 */
import { DEFAULT_ACCENT, type EmailAppointment, type EmailBrand } from "../emails/_shared/brand";
import { customerEntry } from "../lib/event-wording";
import { loadWordingContext } from "../server/calendar-wording";
import { createAppointmentCalendar } from "../server/icalendar";
import { postgresDataKeyStore } from "../server/keys/postgres-store";
import { loadDataKeys } from "../server/keys/ring";
import { postgresRunner } from "../server/workflows/runner";
import { ensureRatingLink } from "../server/rating-requests";
import { renderEmail, type RenderedEmail } from "../server/messaging/email-templates";
import { PermanentSendError, TransientSendError, type MessageProvider } from "../server/messaging/provider";
import { openManageToken, openPrivate } from "../server/messaging/sealed-link";
import { suppressionReason } from "../server/messaging/suppression";
import { parseBrand } from "../lib/brand-theme";
import { canUse, planKeySchema, resolveEntitlements, subscriptionStatuses, type SubscriptionFacts } from "../lib/entitlements";
import { z } from "zod";
import { profileWords, resolveBusinessProfile } from "../lib/terminology";
import type { AppointmentStatus } from "../lib/domain";
import { campaignPayloadSchema, CAMPAIGN_EMAIL_KEY } from "../lib/campaign-contracts";
import { renderBillingEmail } from "./billing-email";
import { renderStaffEmail } from "./staff-email";
import { renderOwnerEmail } from "./owner-email";
import type { ProviderAdapter, ProviderSendRequest, ProviderSendResult } from "./delivery";
import type { TenantDb } from "./handlers/types";

export interface EmailAdapterOptions {
  provider: MessageProvider;
  /** The public origin for links, with no trailing slash. */
  origin: string;
  /** Reply-To when the business has no email of its own. */
  fallbackReplyTo: string | null;
}

interface TenantRow {
  name: string;
  slug: string;
  email: string | null;
  /** Verified by a one-time code before it is ever stored (feature 50); customers' replies go here first. */
  reply_to_email: string | null;
  phone: string | null;
  timezone: string;
  business_type: string;
  terminology: unknown;
  features: unknown;
  brand: unknown;
  /** The business's subscription facts as json, or null when it has none. */
  subscription?: unknown;
  logo_id: string | null;
}

interface AppointmentRow {
  id: string;
  version: number;
  status: AppointmentStatus;
  starts_at: Date;
  ends_at: Date;
  clinic_moved_from: Date | null;
  manage_token_ciphertext: string | null;
  guest_emails_ciphertext: string | null;
  service_name: string;
  practitioner_name: string;
  location_name: string;
  location_address: string;
  location_city: string;
  location_timezone: string | null;
  /** True when the business keeps the address out of messages until a request is approved (feature 41). */
  hide_location_until_confirmed: boolean;
}

async function loadTenant(tenantDb: TenantDb, tenantId: string): Promise<TenantRow | undefined> {
  const rows = await tenantDb`
    select tenant.name, tenant.slug, tenant.email, tenant.reply_to_email, tenant.phone, tenant.timezone,
      tenant.business_type, tenant.terminology, tenant.features, tenant.brand,
      (select row_to_json(plan) from (
        select subscription.plan_key, subscription.status, subscription.trial_ends_at, subscription.current_period_end,
          subscription.cancel_at_period_end, subscription.pending_plan_key, subscription.past_due_since
        from tenant_subscriptions as subscription where subscription.tenant_id = tenant.id) as plan) as subscription,
      (select logo.id from media_assets as logo
        where logo.tenant_id = tenant.id and logo.kind = 'business_logo' and logo.owner_id = tenant.id
        limit 1) as logo_id
    from tenants as tenant where tenant.id = ${tenantId}
  `;
  return rows[0] as TenantRow | undefined;
}

async function loadRecipient(tenantDb: TenantDb, tenantId: string, patientId: string) {
  const rows = await tenantDb`
    select first_name, email from patients where tenant_id = ${tenantId} and id = ${patientId}
  `;
  return rows[0] as { first_name: string; email: string | null } | undefined;
}

async function loadAppointment(tenantDb: TenantDb, tenantId: string, appointmentId: string): Promise<AppointmentRow | undefined> {
  const rows = await tenantDb`
    select appointment.id, appointment.version, appointment.status, appointment.starts_at,
      appointment.ends_at, appointment.clinic_moved_from, appointment.manage_token_ciphertext, appointment.guest_emails_ciphertext,
      service.name as service_name, practitioner.name as practitioner_name,
      location.name as location_name, location.address as location_address,
      location.city as location_city, location.timezone as location_timezone,
      service.hide_location_until_confirmed
    from appointments as appointment
    join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
    join practitioners as practitioner
      on practitioner.tenant_id = appointment.tenant_id and practitioner.id = appointment.practitioner_id
    join locations as location on location.tenant_id = appointment.tenant_id and location.id = appointment.location_id
    where appointment.tenant_id = ${tenantId} and appointment.id = ${appointmentId}
  `;
  return rows[0] as AppointmentRow | undefined;
}

/** The business's own wording for the customer's invite, or nothing when the service sets none (feature 50). */
async function inviteEntry(tenantDb: TenantDb, tenantId: string, appointmentId: string, hidePlace: boolean): Promise<{ title: string; description: string | null } | undefined> {
  // Wording is a nicety: whatever goes wrong reading it, the confirmation still goes out with the usual invite.
  try {
    try {
      await loadDataKeys(postgresDataKeyStore(tenantDb), tenantId);
    } catch {
      // Without keys an answer cannot be opened; the entry is written without answers.
    }
    const context = await loadWordingContext(postgresRunner(tenantDb), tenantId, appointmentId, { hidePlace });
    if (!context || (!context.wording.customerTitle?.trim() && !context.wording.description?.trim())) return undefined;
    return customerEntry(context.wording, context.values, `${context.values.service} · ${context.values.business}`, "", context.questionKeys);
  } catch {
    return undefined;
  }
}

/** "Mon, 16 Nov 2026, 10:30 am IST", in the place's own time zone. */
export function emailWhen(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(date);
}

type AppointmentTemplate =
  | "booking_confirmed"
  | "request_received"
  | "request_approved"
  | "request_declined"
  | "request_expired"
  | "reschedule_requested"
  | "reassigned"
  | "location_changed"
  | "reminder"
  | "rescheduled"
  | "moved_by_business"
  | "cancelled"
  | "review_request";

/** Which email an appointment event becomes. Null means this event has no email. */
export function appointmentTemplateFor(eventType: string, appointment: Pick<AppointmentRow, "status" | "clinic_moved_from">): AppointmentTemplate | null {
  switch (eventType) {
    case "appointment.created":
      return appointment.status === "requested" ? "request_received" : "booking_confirmed";
    case "appointment.confirm":
      return "booking_confirmed";
    case "appointment.status.booked":
      return "request_approved";
    case "appointment.status.declined":
      return "request_declined";
    case "appointment.status.expired":
      return "request_expired";
    case "appointment.reschedule_requested":
      return "reschedule_requested";
    case "appointment.reassigned":
      return "reassigned";
    case "appointment.location_changed":
      return "location_changed";
    case "appointment.reminder":
      return "reminder";
    case "appointment.reschedule":
      return appointment.clinic_moved_from ? "moved_by_business" : "rescheduled";
    case "appointment.suggest":
      return "moved_by_business";
    case "appointment.cancel":
    case "appointment.status.cancelled":
      return "cancelled";
    case "appointment.review_request":
      return "review_request";
    default:
      return null;
  }
}

/** The strings a privacy email needs, read back from the JSON the handler put in the message body. */
function privacyFields(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const textOf = (value: unknown, fallback = ""): string => typeof value === "string" ? value.slice(0, 500) : fallback;
const linesOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((line): line is string => typeof line === "string").slice(0, 20).map((line) => line.slice(0, 400)) : [];

function renderPrivacyEmail(templateKey: string, body: string, customerName: string): ((brand: EmailBrand) => Promise<RenderedEmail>) | null {
  const fields = privacyFields(body);
  if (!fields) return null;
  if (templateKey === "privacy.export") {
    return (brand) => renderEmail("privacy_export_ready", { brand, customerName, url: textOf(fields.url), validDays: Number(fields.validDays) || 7 });
  }
  if (templateKey === "privacy.erasure") {
    return (brand) => renderEmail("privacy_erasure_done", { brand, customerName, removed: linesOf(fields.removed), kept: linesOf(fields.kept) });
  }
  if (templateKey === "privacy.overdue") {
    return (brand) => renderEmail("privacy_request_overdue", {
      brand,
      requestKind: textOf(fields.requestKind, "privacy"),
      dueOn: textOf(fields.dueOn),
      staffUrl: textOf(fields.staffUrl),
    });
  }
  return null;
}

/** The guest addresses sealed on a booking, or none when there are none or they cannot be opened. */
function guestList(tenantId: string, appointmentId: string, sealed: string | null): string[] {
  const opened = openPrivate("guests", tenantId, appointmentId, sealed);
  if (!opened) return [];
  try {
    const parsed: unknown = JSON.parse(opened);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string").slice(0, 10) : [];
  } catch {
    return [];
  }
}

const subscriptionRow = z.object({
  plan_key: planKeySchema,
  status: z.enum(subscriptionStatuses),
  trial_ends_at: z.coerce.date().nullable(),
  current_period_end: z.coerce.date().nullable(),
  cancel_at_period_end: z.boolean(),
  pending_plan_key: planKeySchema.nullable(),
  past_due_since: z.coerce.date().nullable(),
});

/** What the business's plan is right now, from the json the tenant read returns. No row, or one we cannot read, means no paid features. */
function subscriptionFacts(value: unknown): SubscriptionFacts | null {
  const row = subscriptionRow.safeParse(value);
  if (!row.success) return null;
  return {
    planKey: row.data.plan_key, status: row.data.status, trialEndsAt: row.data.trial_ends_at, currentPeriodEnd: row.data.current_period_end,
    cancelAtPeriodEnd: row.data.cancel_at_period_end, pendingPlanKey: row.data.pending_plan_key, pastDueSince: row.data.past_due_since,
  };
}

const skipped = (code: string): ProviderSendResult => ({ status: "skipped", code });

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function createEmailAdapter({ provider, origin, fallbackReplyTo }: EmailAdapterOptions): ProviderAdapter {
  return {
    async send(request: ProviderSendRequest): Promise<ProviderSendResult> {
      const { tenantDb, tenantId, patientId, appointmentId, templateKey, idempotencyKey } = request;
      const isWorkflow = templateKey.startsWith("workflow:");
      const [tenant, loadedRecipient] = await Promise.all([
        loadTenant(tenantDb, tenantId),
        // A workflow test goes to the staff member who asked, never to a customer. A privacy message carries its own address.
        request.testRecipientEmail
          ? Promise.resolve({ first_name: "", email: request.testRecipientEmail })
          : request.recipient ? Promise.resolve(undefined) : loadRecipient(tenantDb, tenantId, patientId),
      ]);
      const recipient = request.recipient ? { first_name: request.recipient.name, email: request.recipient.email } : loadedRecipient;
      if (!tenant) return { status: "rejected", code: "tenant_not_found" };
      const address = recipient?.email?.trim();
      if (!recipient || !address) return skipped("no_destination");

      const suppressed = await suppressionReason(tenantDb, tenantId, "email", address);
      if (suppressed) return skipped(`suppressed_${suppressed}`);

      const words = profileWords(resolveBusinessProfile({
        businessType: tenant.business_type,
        terminology: tenant.terminology,
        features: tenant.features,
      }));
      const brandSettings = parseBrand(tenant.brand);
      const entitlements = resolveEntitlements(subscriptionFacts(tenant.subscription));
      const brand: EmailBrand = {
        businessName: tenant.name,
        logoUrl: tenant.logo_id
          ? `${origin}/api/public/media/${encodeURIComponent(tenant.slug)}/${encodeURIComponent(tenant.logo_id)}`
          : null,
        // The business's own colour, and whether its plan lets it drop the "using Kalendr" line (feature 13).
        accentColor: brandSettings.accent ?? DEFAULT_ACCENT,
        showBadge: !(brandSettings.hideBadge && canUse(entitlements, "removeBadge")),
        words,
      };

      let rendered: RenderedEmail;
      let attachments: { filename: string; contentType: string; content: string }[] | undefined;
      // Marketing email carries the List-Unsubscribe pair, so a mail app can offer one-tap unsubscribe (RFC 8058).
      let headers: Record<string, string> | undefined;
      // Guests get the same message without the customer's private link, so they cannot manage the booking.
      let guestRendered: RenderedEmail | null = null;
      let guestAddresses: string[] = [];
      if (templateKey.startsWith("privacy.")) {
        // Privacy messages carry their own details as JSON in the body (see src/worker/handlers/privacy.ts).
        const privacy = renderPrivacyEmail(templateKey, request.body, recipient.first_name);
        if (!privacy) return { status: "rejected", code: "invalid_event" };
        rendered = await privacy(brand);
      } else if (templateKey.startsWith("billing.")) {
        // Kalendr's own billing mail to the business owner (feature 14); the body is plan names and counts as JSON.
        const billing = renderBillingEmail(templateKey, request.body);
        if (!billing) return { status: "rejected", code: "invalid_event" };
        rendered = await billing(brand);
      } else if (templateKey === "staff.alert" || templateKey === "staff.digest" || templateKey === "staff.summary") {
        // A staff member's own alert or morning summary (feature 56); the handler put only first names, services and times in the body.
        const staff = renderStaffEmail(templateKey, request.body);
        if (!staff) return { status: "rejected", code: "invalid_event" };
        rendered = await staff(brand);
      } else if (templateKey.startsWith("owner.")) {
        // Kalendr's own mail to the owner about their setup (features 11 and 13); the body is a kind and a few plain fields as JSON.
        const owner = renderOwnerEmail(templateKey, request.body);
        if (!owner) return { status: "rejected", code: "invalid_event" };
        rendered = await owner(brand);
      } else if (templateKey === "webhook.disabled") {
        // Tells the owner an address was switched off. The handler put only the host in the body.
        const fields = privacyFields(request.body);
        if (!fields) return { status: "rejected", code: "invalid_event" };
        rendered = await renderEmail("webhook_disabled", { brand, host: textOf(fields.host), staffUrl: textOf(fields.staffUrl) });
      } else if (templateKey === CAMPAIGN_EMAIL_KEY) {
        // A campaign message (feature 28). The handler filled in the owner's words and built the booking and unsubscribe links.
        const payload = campaignPayloadSchema.safeParse(parseJsonOrNull(request.body));
        if (!payload.success || !payload.data.unsubscribeUrl) return { status: "rejected", code: "invalid_event" };
        rendered = await renderEmail("campaign_message", {
          brand, subject: payload.data.subject || `A message from ${tenant.name}`, body: payload.data.text,
          bookUrl: payload.data.bookUrl, unsubscribeUrl: payload.data.unsubscribeUrl,
        });
        headers = { "List-Unsubscribe": `<${payload.data.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
      } else if (isWorkflow) {
        // The text was written by the owner and filled in by the workflow; only the layout is ours.
        rendered = await renderEmail("workflow_message", { brand, subject: request.subject || "A message from " + tenant.name, body: request.body });
      } else if (templateKey === "waitlist.offer") {
        // An offered time (feature 21). The handler put the wording's pieces, with the private link, in the body.
        const offer = privacyFields(request.body);
        if (!offer || !textOf(offer.url)) return { status: "rejected", code: "invalid_event" };
        rendered = await renderEmail("waitlist_offer", {
          brand, customerName: recipient.first_name, when: textOf(offer.when), serviceName: textOf(offer.service),
          minutes: Number(offer.minutes) || 15, offerUrl: textOf(offer.url, ""),
        });
      } else if (templateKey === "class.notice") {
        // A message about a place in a class (feature 18). The handler put the wording's pieces and the private link in the body.
        const notice = privacyFields(request.body);
        const kind = notice?.kind;
        if (!notice || (kind !== "enrolled" && kind !== "waitlisted" && kind !== "offer" && kind !== "session_cancelled" && kind !== "broadcast")) return { status: "rejected", code: "invalid_event" };
        rendered = await renderEmail("class_notice", {
          brand, customerName: recipient.first_name, kind, serviceName: textOf(notice.service), when: textOf(notice.when), message: textOf(notice.message, "").slice(0, 500),
          minutes: Number(notice.minutes) || 120, seatUrl: textOf(notice.url, ""),
        });
      } else if (templateKey === "series.confirmation") {
        // One message for a whole repeating series (feature 17). The handler put every date and the link to one visit in the body.
        const series = privacyFields(request.body);
        const kind = series?.kind === "cancelled" || series?.kind === "changed" ? series.kind : "booked";
        const dates = Array.isArray(series?.dates) ? series.dates.filter((line): line is string => typeof line === "string").slice(0, 60).map((line) => line.slice(0, 80)) : [];
        if (!series || dates.length === 0) return { status: "rejected", code: "invalid_event" };
        rendered = await renderEmail("series_confirmation", {
          brand, customerName: recipient.first_name, kind, serviceName: textOf(series.service),
          dates, manageUrl: textOf(series.url),
        });
      } else if (templateKey === "record.shared") {
        rendered = await renderEmail("record_shared", { brand, customerName: recipient.first_name, portalUrl: `${origin}/portal` });
      } else {
        if (!appointmentId) return { status: "rejected", code: "invalid_event" };
        const appointment = await loadAppointment(tenantDb, tenantId, appointmentId);
        if (!appointment) return skipped("appointment_not_found");
        const template = appointmentTemplateFor(templateKey, appointment);
        if (!template) return { status: "rejected", code: "no_email_template" };

        const timeZone = appointment.location_timezone || tenant.timezone;
        const token = openManageToken(tenantId, appointment.id, appointment.manage_token_ciphertext);
        let manageUrl = token ? `${origin}/manage/${encodeURIComponent(token)}` : null;
        // The fixed review message carries the one-tap rating link (feature 51), under the same once-a-month rule as the workflow.
        if (template === "review_request") {
          const ask = await ensureRatingLink(postgresRunner(tenantDb), { tenantId, appointmentId: appointment.id, now: new Date() });
          if (!ask.ok) return skipped(`rating_${ask.reason}`);
          manageUrl = ask.link(origin);
        }
        // A request on a service that hides its address says so only once it is approved.
        const hidePlace = appointment.hide_location_until_confirmed && appointment.status === "requested";
        const details: EmailAppointment = {
          when: emailWhen(appointment.starts_at, timeZone),
          serviceName: appointment.service_name,
          providerName: appointment.practitioner_name,
          place: hidePlace ? "" : [appointment.location_name, appointment.location_address, appointment.location_city].filter(Boolean).join(", "),
          manageUrl,
          businessPhone: tenant.phone,
        };
        const base = { brand, customerName: recipient.first_name, appointment: details };
        guestAddresses = guestList(tenantId, appointment.id, appointment.guest_emails_ciphertext);
        const previousWhen = appointment.clinic_moved_from ? emailWhen(appointment.clinic_moved_from, timeZone) : null;
        const bookAgainUrl = `${origin}/book/${encodeURIComponent(tenant.slug)}`;
        // The link opens straight on the time picker.
        const rescheduleDetails = { ...details, manageUrl: manageUrl ? `${manageUrl}?reschedule=1` : null };
        const changed = template === "reassigned"
          ? { headline: `Your ${words.appointment} is now with someone else`, summary: `${appointment.practitioner_name} will see you. The time has not changed.` }
          : template === "location_changed"
            ? { headline: `Where your ${words.appointment} happens has changed`, summary: "Please check the details below." }
            : null;
        rendered = changed
          ? await renderEmail("visit_changed", { ...base, ...changed })
          : template === "reschedule_requested"
          ? await renderEmail("reschedule_requested", { ...base, appointment: rescheduleDetails, note: request.body })
          : template === "request_declined"
          ? await renderEmail("request_declined", { ...base, explanation: request.body, bookAgainUrl })
          : template === "request_expired"
            ? await renderEmail("request_expired", { ...base, bookAgainUrl })
            : template === "cancelled"
          ? await renderEmail("cancelled", { ...base, bookAgainUrl: `${origin}/book/${encodeURIComponent(tenant.slug)}` })
          : template === "moved_by_business" || template === "rescheduled"
            ? await renderEmail(template, { ...base, previousWhen })
            : await renderEmail(template as "booking_confirmed" | "reminder" | "request_approved" | "request_received" | "review_request", base);

        if (guestAddresses.length > 0 && template !== "review_request" && template !== "request_declined" && template !== "request_expired" && template !== "reschedule_requested") {
          const guestBase = { ...base, customerName: "there", appointment: { ...details, manageUrl: null } };
          guestRendered = changed
            ? await renderEmail("visit_changed", { ...guestBase, ...changed })
            : template === "cancelled"
              ? await renderEmail("cancelled", { ...guestBase, bookAgainUrl: `${origin}/book/${encodeURIComponent(tenant.slug)}` })
              : template === "moved_by_business" || template === "rescheduled"
                ? await renderEmail(template, { ...guestBase, previousWhen })
                : await renderEmail(template as "booking_confirmed" | "reminder" | "request_approved" | "request_received", guestBase);
        }
        // A calendar file with every message that changes the booking, so the customer's calendar stays right.
        if (template !== "review_request" && template !== "request_declined" && template !== "request_expired" && template !== "reschedule_requested") {
          const entry = await inviteEntry(tenantDb, tenantId, appointment.id, hidePlace);
          attachments = [{
            filename: "appointment.ics",
            contentType: "text/calendar; charset=utf-8; method=PUBLISH",
            content: createAppointmentCalendar({
              appointmentId: appointment.id,
              version: appointment.version,
              status: appointment.status,
              startsAt: appointment.starts_at.toISOString(),
              endsAt: appointment.ends_at.toISOString(),
              clinicName: tenant.name,
              clinicPhone: tenant.phone ?? "",
              serviceName: appointment.service_name,
              practitionerName: appointment.practitioner_name,
              locationName: hidePlace ? "" : appointment.location_name,
              locationAddress: hidePlace ? "" : appointment.location_address,
              locationCity: hidePlace ? "" : appointment.location_city,
              words,
              ...(entry ? { entry } : {}),
            }),
          }];
        }
      }

      try {
        const { providerMessageId } = await provider.send({
          to: address,
          fromName: tenant.name,
          replyTo: tenant.reply_to_email?.trim() || tenant.email?.trim() || fallbackReplyTo || undefined,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          attachments,
          ...(headers ? { headers } : {}),
          idempotencyKey,
        });
        // Best effort for each guest: a bounced guest address never stops the customer's own message.
        for (const [index, guest] of (guestRendered ? guestAddresses : []).entries()) {
          if (await suppressionReason(tenantDb, tenantId, "email", guest)) continue;
          try {
            await provider.send({
              to: guest,
              fromName: tenant.name,
              replyTo: tenant.reply_to_email?.trim() || tenant.email?.trim() || fallbackReplyTo || undefined,
              subject: guestRendered!.subject,
              html: guestRendered!.html,
              text: guestRendered!.text,
              attachments,
              idempotencyKey: `${idempotencyKey}:guest:${index}`,
            });
          } catch (guestError) {
            if (guestError instanceof TransientSendError) return { status: "retry", code: guestError.failureCode };
            if (!(guestError instanceof PermanentSendError)) throw guestError;
          }
        }
        return { status: "sent", providerMessageId };
      } catch (error) {
        if (error instanceof TransientSendError) return { status: "retry", code: error.failureCode };
        if (error instanceof PermanentSendError) return { status: "rejected", code: error.failureCode };
        throw error;
      }
    },
  };
}
