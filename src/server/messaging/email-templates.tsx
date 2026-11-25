/**
 * Every email Kalendr sends, by name, rendered to HTML and plain text. The templates live in
 * src/emails so `pnpm email:dev` can preview them; this file is the only place that renders them.
 *
 * No "server-only" import: the worker renders appointment emails.
 */
import { render } from "react-email";
import type { ComponentProps, JSX } from "react";

import BillingPaymentFailedEmail, { subject as billingPaymentFailedSubject } from "../../emails/billing-payment-failed";
import BillingSubscriptionStartedEmail, { subject as billingSubscriptionStartedSubject } from "../../emails/billing-subscription-started";
import OwnerNoticeEmail, { subject as ownerNoticeSubject } from "../../emails/owner-notice";
import BillingTrialEndingEmail, { subject as billingTrialEndingSubject } from "../../emails/billing-trial-ending";
import BillingUsageAlertEmail, { subject as billingUsageAlertSubject } from "../../emails/billing-usage-alert";
import BookingCodeEmail, { subject as bookingCodeSubject } from "../../emails/booking-code";
import BookingConfirmedEmail, { subject as bookingConfirmedSubject } from "../../emails/booking-confirmed";
import CampaignMessageEmail, { subject as campaignMessageSubject } from "../../emails/campaign-message";
import CancelledEmail, { subject as cancelledSubject } from "../../emails/cancelled";
import ContactChangedEmail, { subject as contactChangedSubject } from "../../emails/contact-changed";
import AccountEmailChangeEmail, { subject as accountEmailChangeSubject } from "../../emails/account-email-change";
import EmailVerificationEmail, { subject as emailVerificationSubject } from "../../emails/email-verification";
import MagicLinkEmail, { subject as magicLinkSubject } from "../../emails/magic-link";
import MovedByBusinessEmail, { subject as movedByBusinessSubject } from "../../emails/moved-by-business";
import NewDeviceSignInEmail, { subject as newDeviceSignInSubject } from "../../emails/new-device-sign-in";
import PasswordResetEmail, { subject as passwordResetSubject } from "../../emails/password-reset";
import PrivacyErasureDoneEmail, { subject as privacyErasureDoneSubject } from "../../emails/privacy-erasure-done";
import PrivacyExportReadyEmail, { subject as privacyExportReadySubject } from "../../emails/privacy-export-ready";
import PrivacyRequestOverdueEmail, { subject as privacyRequestOverdueSubject } from "../../emails/privacy-request-overdue";
import RecordSharedEmail, { subject as recordSharedSubject } from "../../emails/record-shared";
import ReminderEmail, { subject as reminderSubject } from "../../emails/reminder";
import RequestApprovedEmail, { subject as requestApprovedSubject } from "../../emails/request-approved";
import RequestReceivedEmail, { subject as requestReceivedSubject } from "../../emails/request-received";
import StaffAlertEmail, { subject as staffAlertSubject } from "../../emails/staff-alert";
import OwnerSummaryEmail, { subject as ownerSummarySubject } from "../../emails/owner-summary";
import StaffDigestEmail, { subject as staffDigestSubject } from "../../emails/staff-digest";
import VisitChangedEmail, { subject as visitChangedSubject } from "../../emails/visit-changed";
import RequestDeclinedEmail, { subject as requestDeclinedSubject } from "../../emails/request-declined";
import RequestExpiredEmail, { subject as requestExpiredSubject } from "../../emails/request-expired";
import RescheduleRequestedEmail, { subject as rescheduleRequestedSubject } from "../../emails/reschedule-requested";
import RescheduledEmail, { subject as rescheduledSubject } from "../../emails/rescheduled";
import ReviewRequestEmail, { subject as reviewRequestSubject } from "../../emails/review-request";
import SecurityChangeEmail, { subject as securityChangeSubject } from "../../emails/security-change";
import SignInCodeEmail, { subject as signInCodeSubject } from "../../emails/sign-in-code";
import StaffInviteEmail, { subject as staffInviteSubject } from "../../emails/staff-invite";
import ClassNoticeEmail, { subject as classNoticeSubject } from "../../emails/class-notice";
import SeriesConfirmationEmail, { subject as seriesConfirmationSubject } from "../../emails/series-confirmation";
import WaitlistOfferEmail, { subject as waitlistOfferSubject } from "../../emails/waitlist-offer";
import WebhookDisabledEmail, { subject as webhookDisabledSubject } from "../../emails/webhook-disabled";
import WorkflowMessageEmail, { subject as workflowMessageSubject } from "../../emails/workflow-message";

interface Template<P> {
  component: (props: P) => JSX.Element;
  subject: (props: P) => string;
}

function template<P>(component: (props: P) => JSX.Element, subject: (props: P) => string): Template<P> {
  return { component, subject };
}

export const emailTemplates = {
  booking_code: template(BookingCodeEmail, bookingCodeSubject),
  booking_confirmed: template(BookingConfirmedEmail, bookingConfirmedSubject),
  request_received: template(RequestReceivedEmail, requestReceivedSubject),
  request_approved: template(RequestApprovedEmail, requestApprovedSubject),
  request_declined: template(RequestDeclinedEmail, requestDeclinedSubject),
  reschedule_requested: template(RescheduleRequestedEmail, rescheduleRequestedSubject),
  visit_changed: template(VisitChangedEmail, visitChangedSubject),
  request_expired: template(RequestExpiredEmail, requestExpiredSubject),
  reminder: template(ReminderEmail, reminderSubject),
  rescheduled: template(RescheduledEmail, rescheduledSubject),
  cancelled: template(CancelledEmail, cancelledSubject),
  moved_by_business: template(MovedByBusinessEmail, movedByBusinessSubject),
  review_request: template(ReviewRequestEmail, reviewRequestSubject),
  sign_in_code: template(SignInCodeEmail, signInCodeSubject),
  contact_changed: template(ContactChangedEmail, contactChangedSubject),
  staff_invite: template(StaffInviteEmail, staffInviteSubject),
  password_reset: template(PasswordResetEmail, passwordResetSubject),
  email_verification: template(EmailVerificationEmail, emailVerificationSubject),
  record_shared: template(RecordSharedEmail, recordSharedSubject),
  magic_link: template(MagicLinkEmail, magicLinkSubject),
  new_device_sign_in: template(NewDeviceSignInEmail, newDeviceSignInSubject),
  security_change: template(SecurityChangeEmail, securityChangeSubject),
  account_email_change: template(AccountEmailChangeEmail, accountEmailChangeSubject),
  privacy_export_ready: template(PrivacyExportReadyEmail, privacyExportReadySubject),
  privacy_erasure_done: template(PrivacyErasureDoneEmail, privacyErasureDoneSubject),
  privacy_request_overdue: template(PrivacyRequestOverdueEmail, privacyRequestOverdueSubject),
  series_confirmation: template(SeriesConfirmationEmail, seriesConfirmationSubject),
  class_notice: template(ClassNoticeEmail, classNoticeSubject),
  waitlist_offer: template(WaitlistOfferEmail, waitlistOfferSubject),
  webhook_disabled: template(WebhookDisabledEmail, webhookDisabledSubject),
  workflow_message: template(WorkflowMessageEmail, workflowMessageSubject),
  campaign_message: template(CampaignMessageEmail, campaignMessageSubject),
  billing_payment_failed: template(BillingPaymentFailedEmail, billingPaymentFailedSubject),
  billing_subscription_started: template(BillingSubscriptionStartedEmail, billingSubscriptionStartedSubject),
  billing_trial_ending: template(BillingTrialEndingEmail, billingTrialEndingSubject),
  billing_usage_alert: template(BillingUsageAlertEmail, billingUsageAlertSubject),
  staff_alert: template(StaffAlertEmail, staffAlertSubject),
  staff_digest: template(StaffDigestEmail, staffDigestSubject),
  owner_summary: template(OwnerSummaryEmail, ownerSummarySubject),
  owner_notice: template(OwnerNoticeEmail, ownerNoticeSubject),
};

export type EmailTemplateName = keyof typeof emailTemplates;
export type EmailTemplateProps<N extends EmailTemplateName> = ComponentProps<(typeof emailTemplates)[N]["component"]>;

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export async function renderEmail<N extends EmailTemplateName>(name: N, props: EmailTemplateProps<N>): Promise<RenderedEmail> {
  const chosen = emailTemplates[name] as unknown as Template<EmailTemplateProps<N>>;
  const element = chosen.component(props);
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { subject: chosen.subject(props).replace(/[\r\n]+/g, " ").slice(0, 200), html, text };
}
