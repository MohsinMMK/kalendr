import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { isDeclineReason } from "@/lib/approval";
import { isCancelReasonCode } from "@/lib/cancel-policy";
import { openNote } from "@/server/booking-policy";
import { clinicSetupState } from "@/lib/clinic-setup";
import { isHeardFrom } from "@/lib/heard-from";
import { cleanOverrides, resolvePermissions } from "@/lib/permissions";
import type { Appointment, Patient, Recall, WaitlistEntry } from "@/lib/domain";
import type {
  StaffAppointment,
  StaffAvailabilityRule,
  StaffMessage,
  StaffScheduleBlock,
  StaffSnapshot,
  StaffTeamMember,
} from "@/lib/staff-snapshot";
import { profileWords } from "@/lib/terminology";

import { ApiError } from "./api-error";
import { loadBusinessProfileIn, loadStaffBusinessProfile } from "./business-profile";
import { parseCustomFieldValues } from "@/lib/visit-fields";
import { getPublicClinicCatalog } from "./public-catalog";
import { can, type StaffContext } from "./staff-context";
import { localTimeValue } from "./staff-credentials";
import { allowedLocationIds, andLocation, andVisibleCustomer, locationOrNoneCondition } from "./location-scope";

interface PatientRow extends Record<string, unknown> {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  date_of_birth: string | null;
  preferred_channel: Patient["preferredChannel"];
  accessibility_need: string | null;
  is_dependent: boolean;
  privacy_accepted_at: Date | string | null;
  messaging_consent_at: Date | string | null;
  blocked_at: Date | string | null;
}

function consentFields(row: PatientRow): Pick<Patient, "privacyAcceptedAt" | "messagingConsentAt" | "blockedAt"> {
  return {
    ...(row.blocked_at ? { blockedAt: new Date(row.blocked_at).toISOString() } : {}),
    ...(row.privacy_accepted_at ? { privacyAcceptedAt: new Date(row.privacy_accepted_at).toISOString() } : {}),
    ...(row.messaging_consent_at ? { messagingConsentAt: new Date(row.messaging_consent_at).toISOString() } : {}),
  };
}

interface AppointmentRow extends Record<string, unknown> {
  id: string;
  location_id: string;
  patient_id: string;
  practitioner_id: string;
  service_id: string;
  resource_ids: string[];
  starts_at: Date | string;
  ends_at: Date | string;
  status: Appointment["status"];
  confirmation_status: Appointment["confirmationStatus"];
  booking_source: Appointment["bookingSource"];
  form_status: Appointment["formStatus"];
  reminder_status: Appointment["reminderStatus"];
  notes: string | null;
  reason_for_visit: string | null;
  delivery_mode: "in_person" | "video" | "phone";
  custom_fields: unknown;
  referrer_host: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  heard_from: string | null;
  series_id: string | null;
  series_index: number | null;
  spam_state: string;
  proposed_json: string[] | null;
  decline_reason_code: string | null;
  cancel_reason_code: string | null;
  cancel_preset_label: string | null;
  cancel_reason_text: string | null;
  cancelled_by: string | null;
  reschedule_reason_text: string | null;
  reschedule_requested_at: Date | string | null;
  rebooked_from_id: string | null;
  version: number;
  clinic_moved_from: Date | string | null;
  checked_in_at: Date | string | null;
  visit_started_at: Date | string | null;
  completed_at: Date | string | null;
  ticket_id: string | null;
  ticket_number: number | null;
  ticket_called_at: Date | string | null;
  ticket_call_count: number | null;
  ticket_urgent: boolean | null;
  ticket_skipped_at: Date | string | null;
  price_minor: number | null;
  paid_minor: number | string | null;
  refunded_minor: number | string | null;
}

interface MessageRow extends Record<string, unknown> {
  id: string;
  appointment_id: string | null;
  patient_id: string | null;
  channel: StaffMessage["channel"];
  template_key: string;
  status: StaffMessage["status"];
  failure_code: string | null;
  created_at: Date | string;
}

interface WaitlistRow extends Record<string, unknown> {
  id: string;
  patient_id: string;
  service_id: string;
  location_id: string;
  preferred_practitioner_ids: string[];
  date_from: string;
  date_to: string;
  time_preference: WaitlistEntry["timePreference"];
  status: WaitlistEntry["status"];
  created_at: Date | string;
}

interface RecallRow extends Record<string, unknown> {
  id: string;
  patient_id: string;
  service_id: string;
  due_at: Date | string;
  status: Recall["status"];
  last_contacted_at: Date | string | null;
}

interface PractitionerIdRow extends Record<string, unknown> {
  id: string;
}

interface TeamRow extends Record<string, unknown> {
  membership_id: string;
  user_id: string;
  email: string;
  name: string;
  role: StaffTeamMember["role"];
  is_active: boolean;
  practitioner_id: string | null;
  permission_overrides: unknown;
  invite_pending: boolean;
  invited_at: Date | string | null;
  last_sign_in_at: Date | string | null;
  second_factor: boolean;
  invite_expires_at: Date | string | null;
  custom_role_id: string | null;
  custom_role_name: string | null;
  job_title: string | null;
  custom_permissions: string[] | null;
  location_ids: string[] | null;
  works_elsewhere: boolean;
}

interface AvailabilityRow extends Record<string, unknown> {
  practitioner_id: string;
  day_of_week: number;
  starts_at_local: string;
  ends_at_local: string;
}

interface ScheduleBlockRow extends Record<string, unknown> {
  id: string;
  practitioner_id: string | null;
  location_id: string | null;
  starts_at: Date | string;
  ends_at: Date | string;
  reason: string;
}

export type { StaffAppointment, StaffSnapshot } from "@/lib/staff-snapshot";

/** A block with no location closes a person everywhere, so a limited person still sees it. */
function blockCondition(context: StaffContext): SQL {
  const condition = locationOrNoneCondition(context, sql`location_id`);
  return condition ? sql`and ${condition}` : sql``;
}

/**
 * What a location-limited person is offered in pickers and on the schedule: their locations, the rooms there, the people
 * who work at them and the services given there. Nothing is changed for anyone who is not limited.
 */
function catalogForLocations(catalog: StaffSnapshot["catalog"], context: StaffContext): StaffSnapshot["catalog"] {
  const allowed = allowedLocationIds(context);
  if (!allowed) return catalog;
  const open = (ids: readonly string[]) => ids.some((id) => allowed.includes(id));
  return {
    ...catalog,
    locations: catalog.locations.filter((location) => allowed.includes(location.id)),
    resources: catalog.resources.filter((resource) => allowed.includes(resource.locationId)),
    practitioners: catalog.practitioners
      .filter((person) => person.locationIds.length === 0 || open(person.locationIds))
      .map((person) => ({ ...person, locationIds: person.locationIds.filter((id) => allowed.includes(id)) })),
    services: catalog.services
      .filter((service) => service.locationIds.length === 0 || open(service.locationIds))
      .map((service) => ({ ...service, locationIds: service.locationIds.filter((id) => allowed.includes(id)) })),
  };
}

export async function getStaffSnapshot(context: StaffContext): Promise<StaffSnapshot> {
  if (context.preview) throw new ApiError(400, "preview_only", "The database snapshot is unavailable in preview mode.");
  const catalog = await getPublicClinicCatalog(context.clinicSlug, { includeInactive: true, forStaff: true });
  if (!catalog || catalog.clinic.id !== context.tenantId) {
    throw new ApiError(403, "forbidden", `The ${profileWords(await loadStaffBusinessProfile(context)).business} catalog is unavailable for this membership.`);
  }
  const data = await withTenant(context.tenantId, async (transaction) => {
    const ownPractitionerRows = context.role === "practitioner"
      ? await transaction.execute<PractitionerIdRow>(sql`
        select id from practitioners where tenant_id = ${context.tenantId}
          and auth_user_id = ${context.userId} limit 1
      `)
      : [];
    if (context.role === "practitioner" && !ownPractitionerRows[0]) {
      throw new ApiError(403, "forbidden", `No ${profileWords(await loadBusinessProfileIn(transaction, context.tenantId)).practitioner} profile is linked to this membership.`);
    }
    const ownPractitionerClause = ownPractitionerRows[0]
      ? sql`and appointment.practitioner_id = ${ownPractitionerRows[0].id}`
      : sql``;
    const appointmentRows = await transaction.execute<AppointmentRow>(sql`
      select appointment.id, appointment.location_id, appointment.patient_id,
        appointment.practitioner_id, appointment.service_id, appointment.starts_at,
        appointment.ends_at, appointment.status, appointment.confirmation_status,
        appointment.booking_source, appointment.form_status, appointment.reminder_status,
        appointment.notes, appointment.version, appointment.clinic_moved_from,
        appointment.checked_in_at, appointment.visit_started_at, appointment.completed_at,
        appointment.reason_for_visit, appointment.custom_fields, appointment.referrer_host,
        appointment.utm_source, appointment.utm_medium, appointment.utm_campaign,
        appointment.heard_from, appointment.price_minor, appointment.delivery_mode,
        appointment.series_id, appointment.series_index, appointment.spam_state,
        to_json(appointment.proposed_starts) as proposed_json, appointment.decline_reason_code,
        appointment.cancel_reason_code, appointment.cancel_preset_label, appointment.cancel_reason_text, appointment.cancelled_by,
        appointment.reschedule_reason_text, appointment.reschedule_requested_at, appointment.rebooked_from_id,
        (select sum(payment.amount_minor) from payments as payment
          where payment.tenant_id = appointment.tenant_id and payment.appointment_id = appointment.id) as paid_minor,
        (select sum(refund.amount_minor) from payment_refunds as refund
          join payments as payment on payment.tenant_id = refund.tenant_id and payment.id = refund.payment_id
          where payment.tenant_id = appointment.tenant_id and payment.appointment_id = appointment.id) as refunded_minor,
        ticket.id as ticket_id, ticket.number as ticket_number, ticket.called_at as ticket_called_at,
        ticket.call_count as ticket_call_count, ticket.urgent as ticket_urgent, ticket.skipped_at as ticket_skipped_at,
        coalesce(array_agg(reservation.resource_id) filter (where reservation.resource_id is not null and reservation.state <> 'released'), '{}'::text[]) as resource_ids
      from appointments as appointment
      left join resource_reservations as reservation
        on reservation.tenant_id = appointment.tenant_id and reservation.appointment_id = appointment.id
      left join queue_tickets as ticket
        on ticket.tenant_id = appointment.tenant_id and ticket.appointment_id = appointment.id
      where appointment.tenant_id = ${context.tenantId}
        ${ownPractitionerClause}
        ${andLocation(context, sql`appointment.location_id`)}
        and appointment.starts_at >= now() - interval '90 days'
        and appointment.starts_at < now() + interval '180 days'
      group by appointment.id, ticket.id
      order by abs(extract(epoch from (appointment.starts_at - now()))), appointment.id limit 1001
    `);
    const waitlistRows = context.role === "practitioner" ? [] : await transaction.execute<WaitlistRow>(sql`
      select id, patient_id, service_id, location_id, preferred_practitioner_ids,
        date_from, date_to, time_preference, status, created_at
      from waitlist_entries where tenant_id = ${context.tenantId}
        ${andLocation(context, sql`location_id`)}
      order by created_at desc limit 501
    `);
    const recallRows = context.role === "practitioner" ? [] : await transaction.execute<RecallRow>(sql`
      select id, patient_id, service_id, due_at, status, last_contacted_at
      from recalls where tenant_id = ${context.tenantId}
        ${andVisibleCustomer(context, sql`recalls.patient_id`)}
      order by due_at, id limit 501
    `);
    const selectedAppointments = appointmentRows.slice(0, 1000);
    const selectedWaitlist = waitlistRows.slice(0, 500);
    const selectedRecalls = recallRows.slice(0, 500);
    const referencedPatientIds = [...new Set([
      ...selectedAppointments.map((row) => row.patient_id),
      ...selectedWaitlist.map((row) => row.patient_id),
      ...selectedRecalls.map((row) => row.patient_id),
    ])];
    const referenceCondition = referencedPatientIds.length
      ? sql`or id in (${sql.join(referencedPatientIds.map((id) => sql`${id}`), sql`, `)})`
      : sql``;
    const practitionerPatientCondition = sql`${context.role === "practitioner" ? sql`and id in (
      select distinct patient_id from appointments where tenant_id = ${context.tenantId}
        and practitioner_id = ${ownPractitionerRows[0]?.id ?? ""}
    )` : sql``} ${andVisibleCustomer(context, sql`patients.id`)}`;
    const patientRows = await transaction.execute<PatientRow>(sql`
      select id, first_name, last_name, phone, email, date_of_birth, preferred_channel,
        accessibility_need, is_dependent, privacy_accepted_at, messaging_consent_at, blocked_at
      from patients where tenant_id = ${context.tenantId} and merged_into_id is null
        and (id in (select id from patients where tenant_id = ${context.tenantId} and merged_into_id is null
          ${practitionerPatientCondition}
          order by updated_at desc, id limit 500) ${referenceCondition})
      order by last_name, first_name, id
    `);
    const totalPatients = await transaction.execute<{ count: number } & Record<string, unknown>>(sql`
      select count(*)::int as count from patients where tenant_id = ${context.tenantId} and merged_into_id is null
        ${practitionerPatientCondition}
    `);
    const [availabilityRows, scheduleBlockRows, teamRows, messageRows] = await Promise.all([
      transaction.execute<AvailabilityRow>(sql`
        select distinct practitioner_id, day_of_week, starts_at_local::text as starts_at_local,
          ends_at_local::text as ends_at_local
        from availability_rules
        where tenant_id = ${context.tenantId} and is_active
          ${andLocation(context, sql`location_id`)}
        order by practitioner_id, day_of_week
      `),
      transaction.execute<ScheduleBlockRow>(sql`
        select id, practitioner_id, location_id, starts_at, ends_at, reason
        from schedule_blocks
        where tenant_id = ${context.tenantId}
          ${blockCondition(context)}
        order by starts_at, id
      `),
      can(context, "team.manage")
        ? transaction.execute<TeamRow>(sql`
            select membership.id as membership_id, membership.user_id, auth_users.email,
              auth_users.name, membership.role, membership.is_active,
              practitioner.id as practitioner_id, membership.permission_overrides,
              (auth_users.password_set_at is null and auth_users.last_sign_in_at is null) as invite_pending, membership.invited_at,
              auth_users.last_sign_in_at,
              (auth_users.two_factor_enabled or exists (select 1 from auth_passkeys where auth_passkeys.user_id = auth_users.id)) as second_factor,
              case when auth_users.password_set_at is null and auth_users.last_sign_in_at is null
                then (select max(verification.expires_at) from auth_verifications as verification where verification.value = auth_users.id) end as invite_expires_at,
              membership.custom_role_id, custom_role.name as custom_role_name, membership.job_title, custom_role.permissions as custom_permissions,
              array(select limited.location_id from membership_locations as limited where limited.tenant_id = membership.tenant_id and limited.membership_id = membership.id order by limited.location_id) as location_ids,
              exists (select 1 from kalendr_resolve_staff_access(membership.user_id) as other where other.tenant_id <> membership.tenant_id) as works_elsewhere
            from memberships as membership
            join auth_users on auth_users.id = membership.user_id
            left join custom_roles as custom_role
              on custom_role.tenant_id = membership.tenant_id and custom_role.id = membership.custom_role_id
            left join practitioners as practitioner
              on practitioner.tenant_id = membership.tenant_id
              and practitioner.auth_user_id = membership.user_id
            where membership.tenant_id = ${context.tenantId}
            union all
            -- Invites to an existing login, not accepted yet: shown exactly as a new person's unused invite is (the typed name
            -- and email, never anything from the login), so the list never tells which emails already had a login. A declined
            -- invite looks the same as one not answered yet.
            select invite.id, invite.stand_in_user_id, invite.email, invite.name, invite.role, invite.is_active,
              invite.practitioner_id, invite.permission_overrides,
              true, invite.invited_at, null::timestamptz, false, invite.expires_at,
              custom_role.id, custom_role.name, invite.job_title, custom_role.permissions,
              array(select location_id from unnest(invite.location_ids) as location_id order by location_id),
              false
            from staff_login_invites as invite
            left join custom_roles as custom_role
              on custom_role.tenant_id = invite.tenant_id and custom_role.id = invite.custom_role_id
            where invite.tenant_id = ${context.tenantId}
            order by name, membership_id
          `)
        : Promise.resolve([] as TeamRow[]),
      transaction.execute<MessageRow>(sql`
        select notification.id, notification.appointment_id, appointment.patient_id,
          notification.channel, notification.template_key,
          case
            when notification.destination_ciphertext like 'local-capture:%' then 'recorded'
            when notification.status = 'sending' then 'sent'
            else notification.status::text
          end as status,
          notification.failure_code, notification.created_at
        from notifications as notification
        left join appointments as appointment
          on appointment.tenant_id = notification.tenant_id and appointment.id = notification.appointment_id
        where notification.tenant_id = ${context.tenantId}
          ${ownPractitionerClause}
          ${andLocation(context, sql`appointment.location_id`)}
        order by notification.created_at desc, notification.id
        limit 100
      `),
    ]);
    return { patientRows, appointmentRows: selectedAppointments, waitlistRows: selectedWaitlist,
      recallRows: selectedRecalls, availabilityRows, scheduleBlockRows, teamRows, messageRows, historicalNames: {
        services: Object.fromEntries(catalog.services.map((row) => [row.id, row.name])),
        practitioners: Object.fromEntries(catalog.practitioners.map((row) => [row.id, row.name])),
        locations: Object.fromEntries(catalog.locations.filter((row) => !allowedLocationIds(context) || allowedLocationIds(context)?.includes(row.id)).map((row) => [row.id, row.name])),
      },
      limits: {
        appointmentsTruncated: appointmentRows.length > 1000,
        patientsTruncated: (totalPatients[0]?.count ?? 0) > 500,
        waitlistTruncated: waitlistRows.length > 500,
        recallsTruncated: recallRows.length > 500,
        appointmentWindow: "90 days past through 180 days ahead",
      },
    };
  });
  const availability: StaffAvailabilityRule[] = data.availabilityRows.map((row) => ({
    practitionerId: row.practitioner_id,
    dayOfWeek: Number(row.day_of_week),
    startsAtLocal: localTimeValue(row.starts_at_local),
    endsAtLocal: localTimeValue(row.ends_at_local),
  }));
  const scheduleBlocks: StaffScheduleBlock[] = data.scheduleBlockRows.map((row) => ({
    id: row.id,
    practitionerId: row.practitioner_id,
    locationId: row.location_id,
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    reason: row.reason,
  }));
  const setup = clinicSetupState({
    slug: catalog.clinic.slug,
    services: catalog.services,
    practitioners: catalog.practitioners,
    resources: catalog.resources,
    activeLocationIds: catalog.locations.filter((location) => location.isActive !== false).map((location) => location.id),
    practitionerIdsWithHours: [...new Set(availability.map((rule) => rule.practitionerId))],
  });
  return {
    catalog: catalogForLocations(catalog, context),
    patients: data.patientRows.map((row): Patient => ({
      id: row.id, clinicId: context.tenantId, firstName: row.first_name, lastName: row.last_name,
      phone: row.phone, email: row.email, preferredChannel: row.preferred_channel,
      isDependent: row.is_dependent,
      ...(row.date_of_birth ? { dateOfBirth: row.date_of_birth } : {}),
      ...(row.accessibility_need ? { accessibilityNeed: row.accessibility_need } : {}),
      ...consentFields(row),
    })),
    appointments: data.appointmentRows.map((row): StaffAppointment => ({
      id: row.id, clinicId: context.tenantId, locationId: row.location_id,
      patientId: row.patient_id, practitionerId: row.practitioner_id,
      serviceId: row.service_id, resourceIds: row.resource_ids,
      startsAt: new Date(row.starts_at).toISOString(), endsAt: new Date(row.ends_at).toISOString(),
      status: row.status, confirmationStatus: row.confirmation_status,
      bookingSource: row.booking_source, formStatus: row.form_status,
      reminderStatus: row.reminder_status, version: row.version,
      ...(row.notes ? { notes: row.notes } : {}),
      ...(row.reason_for_visit ? { reasonForVisit: row.reason_for_visit } : {}),
      ...(row.delivery_mode && row.delivery_mode !== "in_person" ? { deliveryMode: row.delivery_mode } : {}),
      ...(Object.keys(parseCustomFieldValues(row.custom_fields)).length > 0 ? { customFields: parseCustomFieldValues(row.custom_fields) } : {}),
      ...(row.referrer_host ? { referrerHost: row.referrer_host } : {}),
      ...(row.utm_source || row.utm_medium || row.utm_campaign ? { utm: {
        ...(row.utm_source ? { source: row.utm_source } : {}),
        ...(row.utm_medium ? { medium: row.utm_medium } : {}),
        ...(row.utm_campaign ? { campaign: row.utm_campaign } : {}),
      } } : {}),
      ...(isHeardFrom(row.heard_from) ? { heardFrom: row.heard_from } : {}),
      ...(row.status === "requested" && row.proposed_json && row.proposed_json.length > 0 ? { proposedStarts: row.proposed_json.map((value) => new Date(value).toISOString()) } : {}),
      ...(row.status === "declined" && isDeclineReason(row.decline_reason_code) ? { declineReason: row.decline_reason_code } : {}),
      ...(isCancelReasonCode(row.cancel_reason_code) ? { cancelReasonCode: row.cancel_reason_code } : {}),
      ...(row.cancel_preset_label ? { cancelPresetLabel: row.cancel_preset_label } : {}),
      ...(row.cancelled_by === "customer" || row.cancelled_by === "staff" || row.cancelled_by === "system" ? { cancelledBy: row.cancelled_by } : {}),
      ...(openNote("cancel", context.tenantId, row.id, row.cancel_reason_text) ? { cancelNote: openNote("cancel", context.tenantId, row.id, row.cancel_reason_text) ?? "" } : {}),
      ...(openNote("reschedule", context.tenantId, row.id, row.reschedule_reason_text) ? { rescheduleNote: openNote("reschedule", context.tenantId, row.id, row.reschedule_reason_text) ?? "" } : {}),
      ...(row.reschedule_requested_at ? { rescheduleRequestedAt: new Date(row.reschedule_requested_at).toISOString() } : {}),
      ...(row.rebooked_from_id ? { rebookedFromId: row.rebooked_from_id } : {}),
      ...(row.clinic_moved_from ? { clinicMovedFrom: new Date(row.clinic_moved_from).toISOString() } : {}),
      ...(row.checked_in_at ? { checkedInAt: new Date(row.checked_in_at).toISOString() } : {}),
      ...(row.visit_started_at ? { startedAt: new Date(row.visit_started_at).toISOString() } : {}),
      ...(row.completed_at ? { completedAt: new Date(row.completed_at).toISOString() } : {}),
      ...(row.spam_state === "reported" ? { spamState: "reported" as const } : {}),
      ...(row.series_id ? { seriesId: row.series_id, seriesIndex: Number(row.series_index) } : {}),
      ...(row.price_minor !== null ? { priceMinor: Number(row.price_minor) } : {}),
      ...(row.paid_minor !== null ? { paidMinor: Number(row.paid_minor) } : {}),
      ...(row.refunded_minor !== null ? { refundedMinor: Number(row.refunded_minor) } : {}),
      ...(row.ticket_id ? { queue: {
        ticketId: row.ticket_id, number: Number(row.ticket_number), callCount: Number(row.ticket_call_count ?? 0),
        urgent: row.ticket_urgent === true,
        ...(row.ticket_called_at ? { calledAt: new Date(row.ticket_called_at).toISOString() } : {}),
        ...(row.ticket_skipped_at ? { skippedAt: new Date(row.ticket_skipped_at).toISOString() } : {}),
      } } : {}),
    })),
    waitlist: data.waitlistRows.map((row): WaitlistEntry => ({
      id: row.id, patientId: row.patient_id, serviceId: row.service_id,
      locationId: row.location_id, preferredPractitionerIds: row.preferred_practitioner_ids,
      dateFrom: row.date_from, dateTo: row.date_to, timePreference: row.time_preference,
      status: row.status, createdAt: new Date(row.created_at).toISOString(),
    })),
    recalls: data.recallRows.map((row): Recall => ({
      id: row.id, patientId: row.patient_id, serviceId: row.service_id,
      dueAt: new Date(row.due_at).toISOString(), status: row.status,
      ...(row.last_contacted_at ? { lastContactedAt: new Date(row.last_contacted_at).toISOString() } : {}),
    })),
    team: data.teamRows.map((row): StaffTeamMember => ({
      membershipId: row.membership_id,
      userId: row.user_id,
      email: row.email,
      name: row.name,
      role: row.role,
      isActive: row.is_active,
      practitionerId: row.practitioner_id,
      permissionOverrides: cleanOverrides(row.role, row.permission_overrides, row.custom_permissions),
      permissions: resolvePermissions(row.role, row.permission_overrides, row.custom_permissions),
      customRoleId: row.custom_role_id,
      customRoleName: row.custom_role_name,
      jobTitle: row.job_title,
      invitePending: row.invite_pending,
      invitedAt: row.invited_at ? new Date(row.invited_at).toISOString() : null,
      lastSignInAt: row.last_sign_in_at ? new Date(row.last_sign_in_at).toISOString() : null,
      secondFactor: row.second_factor,
      inviteExpiresAt: row.invite_expires_at ? new Date(row.invite_expires_at).toISOString() : null,
      locationIds: row.location_ids ?? [],
      ...(row.works_elsewhere ? { worksElsewhere: true } : {}),
    })),
    availability,
    scheduleBlocks,
    messages: data.messageRows.map((row): StaffMessage => ({
      id: row.id,
      appointmentId: row.appointment_id,
      patientId: row.patient_id,
      channel: row.channel,
      templateKey: row.template_key,
      status: row.status,
      failureCode: row.failure_code,
      createdAt: new Date(row.created_at).toISOString(),
    })),
    setup,
    fetchedAt: new Date().toISOString(),
    historicalNames: data.historicalNames,
    limits: data.limits,
  };
}

export async function searchStaffPatients(
  context: StaffContext,
  query: string,
  limit = 50,
): Promise<{ patients: Patient[]; truncated: boolean }> {
  if (context.preview) {
    throw new ApiError(400, "preview_only", `${profileWords(await loadStaffBusinessProfile(context)).Customer} search is unavailable in preview mode.`);
  }
  const capped = Math.min(Math.max(limit, 1), 50);
  return withTenant(context.tenantId, async (transaction) => {
    const ownPractitionerRows = context.role === "practitioner"
      ? await transaction.execute<PractitionerIdRow>(sql`
        select id from practitioners where tenant_id = ${context.tenantId}
          and auth_user_id = ${context.userId} limit 1
      `)
      : [];
    if (context.role === "practitioner" && !ownPractitionerRows[0]) {
      throw new ApiError(403, "forbidden", `No ${profileWords(await loadBusinessProfileIn(transaction, context.tenantId)).practitioner} profile is linked to this membership.`);
    }
    const practitionerPatientCondition = sql`${ownPractitionerRows[0]
      ? sql`and id in (
        select distinct patient_id from appointments where tenant_id = ${context.tenantId}
          and practitioner_id = ${ownPractitionerRows[0].id}
      )`
      : sql``} ${andVisibleCustomer(context, sql`patients.id`)}`;
    const normalized = query.trim();
    const digits = normalized.replace(/\D/g, "");
    const pattern = `%${normalized.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const searchCondition = normalized
      ? sql`and (
        first_name ilike ${pattern} escape '\\'
        or last_name ilike ${pattern} escape '\\'
        or (first_name || ' ' || last_name) ilike ${pattern} escape '\\'
        or id ilike ${pattern} escape '\\'
        or email ilike ${pattern} escape '\\'
        ${digits.length >= 3 ? sql`or regexp_replace(phone, '\\D', '', 'g') like ${`%${digits}%`}` : sql``}
      )`
      : sql``;
    const rows = await transaction.execute<PatientRow>(sql`
      select id, first_name, last_name, phone, email, date_of_birth, preferred_channel,
        accessibility_need, is_dependent, privacy_accepted_at, messaging_consent_at, blocked_at
      from patients where tenant_id = ${context.tenantId} and merged_into_id is null
        ${practitionerPatientCondition} ${searchCondition}
      order by last_name, first_name, id
      limit ${capped + 1}
    `);
    return {
      patients: rows.slice(0, capped).map((row): Patient => ({
        id: row.id, clinicId: context.tenantId, firstName: row.first_name, lastName: row.last_name,
        phone: row.phone, email: row.email, preferredChannel: row.preferred_channel,
        isDependent: row.is_dependent,
        ...(row.date_of_birth ? { dateOfBirth: row.date_of_birth } : {}),
        ...(row.accessibility_need ? { accessibilityNeed: row.accessibility_need } : {}),
        ...consentFields(row),
      })),
      truncated: rows.length > capped,
    };
  });
}
