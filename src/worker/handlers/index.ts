import { QUICK_MESSAGE_EVENT } from "../../lib/quick-messages";
import { appointmentMessageHandler, type HandlerDependencies } from "./appointment-message";
import { appointmentChangeHandler } from "./appointment-change";
import { appointmentReminderHandler } from "./appointment-reminder";
import { calendarHandlers, withCalendarWrite } from "../calendar";
import { paymentHandlers } from "../payments";
import { invoiceHandlers } from "../invoicing";
import { offersHandlers } from "../offers";
import { pushSendHandler } from "./push-send";
import { STAFF_DIGEST_EVENT, STAFF_EMAIL_EVENT } from "../../lib/staff-alerts";
import { ACCOUNT_EMAIL_NOTICE_EVENT } from "../../lib/staff-email";
import { ownerSummaryHandler, staffDigestHandler, staffEmailHandler } from "./staff-notify";
import { OWNER_SUMMARY_EVENT } from "../../lib/owner-summary";
import { erasureApprovedHandler, exportRequestedHandler, requestOverdueHandler } from "./privacy";
import { ASSISTANT_INBOUND_EVENT, assistantInboundHandler } from "./assistant-inbound";
import { accountEmailNoticeHandler } from "./account-email-notice";
import { EMAIL_CHECK_EVENT, emailCheckHandler } from "./email-check";
import { VERIFICATION_RESEND_EVENT, verificationResendHandler } from "./verification-resend";
import {
  channelInboundHandler, channelStatusHandler, CHANNEL_INBOUND_EVENT, CHANNEL_STATUS_EVENT,
  smsFallbackHandler, SMS_FALLBACK_EVENT, threadReplyHandler, THREAD_REPLY_EVENT,
} from "./channel-events";
import { BILLING_EMAIL_EVENT, BILLING_EVENT, BILLING_PROVIDER_EVENT } from "../../server/billing/webhook-events";
import { billingEmailHandler, billingEventHandler, billingProviderChangeHandler } from "./billing";
import { recordSharedHandler } from "./record-shared";
import { videoRoomEndHandler, videoRoomHandler } from "./video-room";
import { REPORT_EXPORT_EVENT } from "../../lib/reports";
import { reportExportHandler } from "../reports";
import { reviewRequestHandler } from "./review-request";
import { OFFER_EXPIRE_EVENT, WAITLIST_MATCH_EVENT } from "../../server/waitlist-offers";
import { offerExpireHandler, waitlistMatchHandler } from "./waitlist";
import { SERIES_CONFIRMATION_EVENT } from "../../lib/series-contracts";
import { seriesConfirmationHandler } from "./series";
import { CLASS_NOTICE_EVENT, CLASS_OFFER_EXPIRE_EVENT } from "../../lib/classes-contracts";
import { classNoticeHandler, classOfferExpireHandler } from "./class-notice";
import { workflowMessageHandler, workflowTestHandler } from "./workflow-message";
import { CAMPAIGN_FANOUT_EVENT, CAMPAIGN_SEND_EVENT, CAMPAIGN_TEST_EVENT } from "../../lib/campaign-contracts";
import { campaignFanoutHandler, campaignSendHandler, campaignTestHandler } from "./campaign";
import { fileRemoveHandler, scanFileHandler } from "./scan-file";
import { onboardingEmailHandler } from "../onboarding-jobs";
import { ONBOARDING_EMAIL_EVENT } from "../../server/onboarding/events";
import { DOMAIN_NOTICE_EVENT, domainCheckHandler, domainNoticeHandler } from "../domain-jobs";
import { DOMAIN_CHECK_EVENT } from "../../server/domains/events";
import { importHandlers } from "./import";
import { webhookDeliverHandler } from "./webhook-deliver";
import { webhookDisabledHandler } from "./webhook-disabled";
import { withWebhookFanout, webhookOnlyHandler, WEBHOOK_DELIVER_EVENT } from "../webhooks/fanout";
import { appCheckHandler, appDeliverHandler, appRemoveHandler, type AppDependencies } from "../apps/deliver";
import { APP_CHECK_EVENT, APP_DELIVER_EVENT, APP_REMOVE_EVENT } from "../../server/apps/events";
import type { EventHandler } from "./types";

export type { HandlerDependencies } from "./appointment-message";
export type { AppDependencies };
export type { EventHandler, OutboxEvent, TenantDb } from "./types";

const appointmentChangeEvents = [
  "appointment.created",
  "appointment.confirm",
  "appointment.reschedule",
  "appointment.suggest",
  "appointment.cancel",
  "appointment.status.requested",
  "appointment.status.booked",
  "appointment.status.checked_in",
  "appointment.status.completed",
  "appointment.status.cancelled",
  "appointment.status.declined",
  "appointment.status.expired",
  "appointment.reschedule_requested",
  "appointment.reassigned",
  "appointment.location_changed",
  "appointment.status.no_show",
  "appointment.status.entered_in_error",
] as const;

export type HandlerRegistry = ReadonlyMap<string, EventHandler>;

/** Event type to handler. An event type with no handler goes to dead letter as invalid_event. */
export function createHandlers(dependencies: HandlerDependencies): HandlerRegistry {
  // Each change also queues a calendar write (feature 16) as its own row, so neither retries the other.
  const change = withWebhookFanout(withCalendarWrite(appointmentChangeHandler(dependencies)), dependencies.now);
  return new Map<string, EventHandler>([
    ...appointmentChangeEvents.map((eventType) => [eventType, change] as const),
    ["appointment.reminder", appointmentReminderHandler(dependencies)],
    ["appointment.review_request", reviewRequestHandler(dependencies)],
    ["record.shared", recordSharedHandler(dependencies)],
    ["video.room", videoRoomHandler(dependencies)],
    ["video.room.end", videoRoomEndHandler(dependencies)],
    ["workflow.message", workflowMessageHandler(dependencies)],
    ["workflow.test", workflowTestHandler(dependencies)],
    // Campaigns and win-back (feature 28): see docs/WORKER.md.
    [CAMPAIGN_FANOUT_EVENT, campaignFanoutHandler(dependencies)],
    [CAMPAIGN_SEND_EVENT, campaignSendHandler(dependencies)],
    [CAMPAIGN_TEST_EVENT, campaignTestHandler(dependencies)],
    [QUICK_MESSAGE_EVENT, appointmentMessageHandler(dependencies)],
    ["push.send", pushSendHandler(dependencies.push)],
    // Staff alerts by email and the morning summary (feature 56).
    [STAFF_EMAIL_EVENT, staffEmailHandler(dependencies)],
    [STAFF_DIGEST_EVENT, staffDigestHandler(dependencies)],
    [OWNER_SUMMARY_EVENT, ownerSummaryHandler(dependencies)],
    ...calendarHandlers(dependencies.calendar),
    ...paymentHandlers({ now: dependencies.now, ...dependencies.payments }),
    ...invoiceHandlers(),
    // Large report exports (feature 26): built here, downloaded from the staff screen.
    [REPORT_EXPORT_EVENT, reportExportHandler()],
    ...offersHandlers(dependencies),
    ["privacy.export.requested", exportRequestedHandler(dependencies)],
    ["privacy.erasure.approved", erasureApprovedHandler(dependencies)],
    ["privacy.request.overdue", requestOverdueHandler(dependencies)],
    [EMAIL_CHECK_EVENT, emailCheckHandler(dependencies)],
    // "Your sign-in email changed" notices to the old and new address (staff email change).
    [ACCOUNT_EMAIL_NOTICE_EVENT, accountEmailNoticeHandler(dependencies)],
    [VERIFICATION_RESEND_EVENT, verificationResendHandler(dependencies)],
    [CHANNEL_STATUS_EVENT, channelStatusHandler()],
    [CHANNEL_INBOUND_EVENT, channelInboundHandler(dependencies)],
    [THREAD_REPLY_EVENT, threadReplyHandler(dependencies, dependencies.allowUnapprovedTemplates ?? false)],
    [SMS_FALLBACK_EVENT, smsFallbackHandler(dependencies)],
    // The booking assistant answering a customer's text (feature 30).
    [ASSISTANT_INBOUND_EVENT, assistantInboundHandler({ ...(dependencies.databaseUrl ? { databaseUrl: dependencies.databaseUrl } : {}), now: dependencies.now })],
    [WAITLIST_MATCH_EVENT, waitlistMatchHandler(dependencies)],
    [OFFER_EXPIRE_EVENT, offerExpireHandler(dependencies)],
    [SERIES_CONFIRMATION_EVENT, seriesConfirmationHandler(dependencies)],
    // Group sessions and classes (feature 18): messages about a place, and the offered seat running out of time.
    [CLASS_NOTICE_EVENT, classNoticeHandler(dependencies)],
    [CLASS_OFFER_EXPIRE_EVENT, classOfferExpireHandler(dependencies)],
    // Subscription billing (feature 14): provider webhooks, owner emails and provider changes, all off the request.
    [BILLING_EVENT, billingEventHandler(dependencies)],
    [BILLING_EMAIL_EVENT, billingEmailHandler(dependencies)],
    [BILLING_PROVIDER_EVENT, billingProviderChangeHandler()],
    // Own web addresses (feature 13): a lookup the owner asked for, and the owner emails about an address.
    [DOMAIN_CHECK_EVENT, domainCheckHandler(dependencies)],
    [DOMAIN_NOTICE_EVENT, domainNoticeHandler(dependencies)],
    // Onboarding emails to a new owner (feature 11).
    [ONBOARDING_EMAIL_EVENT, onboardingEmailHandler(dependencies)],
    ["file.scan", scanFileHandler()],
    ["file.remove", fileRemoveHandler()],
    ...importHandlers({ databaseUrl: dependencies.databaseUrl }),
    ["customer.created", webhookOnlyHandler(dependencies.now)],
    ["payment.captured", webhookOnlyHandler(dependencies.now)],
    [WEBHOOK_DELIVER_EVENT, webhookDeliverHandler(dependencies.webhooks ?? {}, dependencies.now)],
    ["webhook.endpoint.disabled", webhookDisabledHandler(dependencies)],
    // Installed apps (feature 55): delivery, the check after install, and removal.
    [APP_DELIVER_EVENT, appDeliverHandler(dependencies.apps ?? {}, dependencies.now)],
    [APP_CHECK_EVENT, appCheckHandler(dependencies.apps ?? {}, dependencies.now)],
    [APP_REMOVE_EVENT, appRemoveHandler(dependencies.apps ?? {})],
  ]);
}
