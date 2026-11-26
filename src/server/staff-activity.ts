import "server-only";

import { sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditActionGroups } from "@/lib/enterprise-contracts";
import { isPermission, permissionGroupsFor, permissionLabels, roleLabelsFor, type Permission, type StaffRole } from "@/lib/permissions";
import { defaultBusinessProfile, profileWords, type BusinessProfile, type TermWords } from "@/lib/terminology";

import { ApiError } from "./api-error";
import { loadBusinessProfileIn } from "./business-profile";
import { requirePermission, type StaffContext } from "./staff-context";

export const activityCategories = ["all", "team", "settings", "visits", "records", "refused"] as const;
export type ActivityCategory = (typeof activityCategories)[number];

export interface ActivityEntry {
  id: string;
  occurredAt: string;
  actor: string;
  outcome: "success" | "denied" | "failed";
  /** One plain sentence: "Changed Asha Rao's role". */
  summary: string;
  /** What changed, one line each: "Role: Receptionist → Admin", "Granted: Open client records". */
  changes: string[];
  appointmentId: string | null;
  /** True for what Kalendr support did to this business (a session, a pause). The screen gives it its own badge. */
  support?: boolean;
}

export interface ActivityPage {
  entries: ActivityEntry[];
  nextCursor: string | null;
}

type Row = {
  id: string;
  action: string;
  outcome: ActivityEntry["outcome"];
  actor_type: string;
  actor_name: string | null;
  appointment_id: string | null;
  metadata: Record<string, unknown> | null;
  occurred_at: Date | string;
  /** The reason the operator typed for a support session, from impersonation_sessions (readable by the business itself). */
  support_reason: string | null;
  /** True when the acting user is a platform operator who has had a support session in this business. */
  by_operator: boolean;
};

const pageSize = 40;

const categoryFilters: Record<Exclude<ActivityCategory, "all">, ReturnType<typeof sql>> = {
  team: sql`(event.action like 'staff.%' and event.action <> 'staff.permission.refused') or event.action like 'support.%'`,
  settings: sql`(event.action like 'settings.%' or event.action = 'clinic.registered')`,
  visits: sql`(event.action like 'appointment.%' or event.action like 'waitlist.%' or event.action like 'recall.%' or event.action = 'patient.created' or event.action = 'message.retry')`,
  records: sql`event.action like 'record.%'`,
  refused: sql`event.outcome = 'denied'`,
};

function recordActions(t: TermWords): Record<string, string> {
  return {
    "record.create": `Wrote ${t.aVisit} record`,
    "record.edit": `Edited ${t.aVisit} record`,
    "record.delete": `Deleted ${t.aVisit} record`,
    "record.view": `Opened ${t.aVisit} record`,
    "record.share": `Shared a record with the ${t.customer}`,
    "record.shared": `Shared a record with the ${t.customer}`,
    "record.withdraw": "Withdrew a shared record",
    "record.file.add": "Attached a file to a record",
    "record.file.remove": "Removed a file from a record",
    "record.file.view": "Opened a record file",
    "record.access.confirm": `Confirmed ${t.aCustomer}'s identity for records`,
    "record.access.request": "Asked to see their records",
    "record.access.date_of_birth": "Checked their date of birth for records",
  };
}

function visitActions(t: TermWords): Record<string, string> {
  return {
    "appointment.created": `Booked ${t.aVisit}`,
    "appointment.confirm": `Confirmed ${t.aVisit}`,
    "appointment.cancel": `Cancelled ${t.aVisit}`,
    "appointment.reschedule": `Moved ${t.aVisit}`,
    "appointment.form_received": "Marked a form as received",
    "appointment.started": `Started ${t.aVisit}`,
    "appointment.status.confirmed": `Approved ${t.aVisit}`,
    "appointment.status.declined": `Declined ${t.aVisit}`,
    "appointment.status.checked_in": `Checked ${t.aCustomer} in`,
    "appointment.status.in_progress": `Started ${t.aVisit}`,
    "appointment.status.completed": `Completed ${t.aVisit}`,
    "appointment.status.no_show": "Marked a no-show",
    "appointment.status.cancelled": `Cancelled ${t.aVisit}`,
    "patient.created": `Added ${t.aCustomer}`,
    "waitlist.created": "Added someone to the waitlist",
  };
}

function settingsActions(t: TermWords): Record<string, string> {
  return {
    "clinic.registered": `Registered the ${t.business}`,
    "settings.clinic.updated": `Changed the ${t.business} details`,
    "settings.service.created": "Added a service",
    "settings.service.updated": "Changed a service",
    "settings.services.booking_mode": "Changed how services are booked",
    "settings.resource.created": "Added a room or chair",
    "settings.schedule_block.created": "Blocked time on the schedule",
    "settings.schedule_block.deleted": "Removed blocked time",
  };
}

function profileFields(profile: BusinessProfile): Record<string, string> {
  return {
    name: "name",
    title: profile.providerFields.title.toLowerCase(),
    specialty: profile.providerFields.specialty.toLowerCase(),
    email: "email",
    phone: "phone",
    bio: "bio",
    photo: "photo",
    qualifications: "qualifications",
    registrationNumber: profile.providerFields.registrationNumber.toLowerCase(),
    experienceYears: "experience",
    languages: "languages",
    serviceIds: "services",
    hours: "working hours",
    isActive: "active",
    jobTitle: "job title",
  };
}

/** Sign-in, second-factor and organisation events (feature 53), in one plain sentence each. */
const signInAndOrgActions: Record<string, string> = {
  "staff.sign_in": "Signed in",
  "staff.sign_in.failed": "A sign-in failed",
  "staff.sign_in.refused": "A sign-in was refused",
  "staff.sso.sign_in": "Signed in with company sign-in",
  "staff.sso.sign_in.failed": "A company sign-in failed",
  "staff.second_factor.enabled": "Turned on a second factor",
  "staff.second_factor.disabled": "Turned off a second factor",
  "staff.second_factor.verified": "Passed the second-factor check",
  "staff.second_factor.failed": "Failed the second-factor check",
  "staff.second_factor.backup_codes_regenerated": "Made new backup codes",
  "staff.passkey.added": "Added a passkey",
  "staff.passkey.removed": "Removed a passkey",
  "staff.device.removed": "Signed a device out",
  "staff.devices.removed_all": "Signed every other device out",
  "enterprise.role.created": "Made a custom role",
  "enterprise.role.updated": "Changed a custom role",
  "enterprise.role.deleted": "Deleted a custom role",
  "enterprise.team.created": "Added a team",
  "enterprise.team.updated": "Changed a team",
  "enterprise.team.deleted": "Deleted a team",
  "enterprise.attribute.created": "Added an attribute",
  "enterprise.attribute.updated": "Changed an attribute",
  "enterprise.attribute.deleted": "Deleted an attribute",
  "enterprise.attribute.values_set": "Set a person's attributes",
  "enterprise.defaults.updated": "Changed the organisation defaults",
  "enterprise.domain.added": "Added a company domain",
  "enterprise.domain.verified": "Proved a company domain",
  "enterprise.domain.updated": "Changed a company domain's rules",
  "enterprise.domain.removed": "Removed a company domain",
  "enterprise.sso.saved": "Saved a company sign-in connection",
  "enterprise.sso.status": "Switched a company sign-in connection on or off",
  "enterprise.sso.removed": "Removed a company sign-in connection",
  "enterprise.scim.token_created": "Made a directory sync token",
  "enterprise.scim.token_revoked": "Revoked a directory sync token",
  "enterprise.scim.user_created": "The company directory added someone",
  "enterprise.scim.user_updated": "The company directory changed someone",
  "enterprise.scim.user_deactivated": "The company directory deactivated someone",
  "enterprise.scim.group_changed": "The company directory changed a team",
  "audit.exported": "Downloaded the activity log",
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function roleName(value: unknown, profile: BusinessProfile): string {
  const labels = roleLabelsFor(profile);
  return typeof value === "string" && value in labels ? labels[value as StaffRole] : String(value);
}

/** A permission's name in the business's words. Falls back to the default name when the business has that feature off. */
function permissionName(key: Permission, profile: BusinessProfile): string {
  const item = permissionGroupsFor(profile).flatMap((group) => group.items).find((candidate) => candidate.key === key);
  return item?.label ?? permissionLabels[key];
}

function permissionList(value: unknown, profile: BusinessProfile): string[] {
  return Array.isArray(value) ? value.filter((key): key is Permission => typeof key === "string" && isPermission(key)).map((key) => permissionName(key, profile)) : [];
}

function fromTo(value: unknown): { from: unknown; to: unknown } | null {
  return value && typeof value === "object" && "from" in value && "to" in value ? value as { from: unknown; to: unknown } : null;
}

function accessChanges(metadata: Record<string, unknown>, profile: BusinessProfile): string[] {
  const changes: string[] = [];
  const role = fromTo(metadata.role);
  if (role) changes.push(`Role: ${roleName(role.from, profile)} → ${roleName(role.to, profile)}`);
  const granted = permissionList(metadata.granted, profile);
  const revoked = permissionList(metadata.revoked, profile);
  if (granted.length) changes.push(`Allowed: ${granted.join(", ")}`);
  if (revoked.length) changes.push(`Taken away: ${revoked.join(", ")}`);
  return changes;
}

/** Turns a stored audit event into a sentence a clinic owner can read. Unknown actions fall back to their code. */
export function describeActivity(
  action: string,
  metadata: Record<string, unknown>,
  profile: BusinessProfile = defaultBusinessProfile,
): Pick<ActivityEntry, "summary" | "changes"> {
  const t = profileWords(profile);
  const fields = profileFields(profile);
  const name = text(metadata.name) ?? "someone";
  switch (action) {
    case "support.session.started": {
      const reason = text(metadata.supportReason);
      return { summary: metadata.write === true ? "Kalendr support started a session (changes allowed)" : "Kalendr support started a session (read-only)", changes: reason ? [`Reason: ${reason}`] : [] };
    }
    case "support.session.ended":
      return { summary: "Kalendr support ended a session", changes: [] };
    case "support.business.paused":
      return { summary: "Kalendr support paused this business", changes: [] };
    case "support.business.resumed":
      return { summary: "Kalendr support resumed this business", changes: [] };
    case "staff.member.created": {
      const overrides = metadata.permissionOverrides && typeof metadata.permissionOverrides === "object" ? Object.keys(metadata.permissionOverrides) : [];
      return {
        summary: `Invited ${name} as ${roleName(metadata.role, profile)}`,
        changes: [text(metadata.email), overrides.length ? `${overrides.length} permission ${overrides.length === 1 ? "change" : "changes"} from the role's defaults` : null].filter((line): line is string => Boolean(line)),
      };
    }
    case "api_key.created":
      return { summary: "Created an API key", changes: [text(metadata.prefix) ? `Starts with ${text(metadata.prefix)}` : null].filter((line): line is string => Boolean(line)) };
    case "api_key.revoked":
      return { summary: "Revoked an API key", changes: [text(metadata.prefix) ? `Starts with ${text(metadata.prefix)}` : null].filter((line): line is string => Boolean(line)) };
    case "webhook.endpoint.created":
      return { summary: "Added a webhook address", changes: [] };
    case "webhook.endpoint.updated":
      return { summary: "Changed a webhook address", changes: [] };
    case "webhook.endpoint.deleted":
      return { summary: "Removed a webhook address", changes: [] };
    case "webhook.endpoint.secret_rotated":
      return { summary: "Made a new signing secret for a webhook address", changes: [] };
    case "webhook.endpoint.test_sent":
      return { summary: "Sent a test event to a webhook address", changes: [] };
    case "webhook.endpoint.disabled":
      return { summary: "Turned off a webhook address after repeated failures", changes: [] };
    case "webhook.delivery.resent":
      return { summary: "Sent a webhook event again", changes: [] };
    case "staff.member.role_changed":
      return { summary: `Changed ${name}'s role`, changes: accessChanges(metadata, profile) };
    case "staff.member.permissions_changed":
      return { summary: `Changed what ${name} can do`, changes: accessChanges(metadata, profile) };
    case "staff.member.job_title_changed":
      return { summary: `Changed ${name}'s job title`, changes: [] };
    case "staff.member.locations_changed": {
      // The row keeps location ids only (an empty list means every location), so the sentence counts them.
      const locations = fromTo(metadata.locations);
      const count = (ids: unknown) => Array.isArray(ids) && ids.length
        ? `${ids.length} ${ids.length === 1 ? t.location : t.locations}`
        : `Every ${t.location}`;
      return { summary: `Changed which ${t.locations} ${name} works at`, changes: locations ? [`${t.Locations}: ${count(locations.from)} → ${count(locations.to)}`] : [] };
    }
    case "staff.member.activated":
      return { summary: `Reactivated ${name}`, changes: accessChanges(metadata, profile) };
    case "staff.member.deactivated":
      return { summary: `Deactivated ${name}`, changes: ["Signed out on every device", ...accessChanges(metadata, profile)] };
    case "staff.member.invite_sent":
      return { summary: `Sent ${name} a new invite link`, changes: [] };
    case "staff.member.reset_sent":
      return { summary: `Sent ${name} a password reset link`, changes: [] };
    case "staff.practitioner.created":
      return {
        summary: metadata.attachedToCurrentUser ? `Added their own ${t.provider} profile` : `Added ${name} as ${t.aProvider}`,
        changes: [text(metadata.email) ? `Invite sent to ${text(metadata.email)}` : null].filter((line): line is string => Boolean(line)),
      };
    case "staff.practitioner.updated": {
      const changed = Array.isArray(metadata.changed) ? metadata.changed.filter((key): key is string => typeof key === "string") : [];
      const active = fromTo(metadata.isActive);
      if (active) return { summary: `${active.to ? "Reactivated" : "Deactivated"} ${name}'s ${t.provider} profile`, changes: [] };
      if (metadata.self) return { summary: `Updated their own ${changed.includes("hours") && changed.length === 1 ? "working hours" : "profile"}`, changes: changed.map((key) => `Changed ${fields[key] ?? key}`) };
      return { summary: changed.length === 1 && changed[0] === "hours" ? `Changed ${name}'s working hours` : `Edited ${name}'s profile`, changes: changed.filter((key) => key !== "isActive").map((key) => `Changed ${fields[key] ?? key}`) };
    }
    case "staff.profile.updated": {
      const changed = Array.isArray(metadata.changed) ? metadata.changed.filter((key): key is string => typeof key === "string") : [];
      return { summary: "Updated their own profile", changes: changed.map((key) => `Changed ${fields[key] ?? key}`) };
    }
    case "message.retry":
      return { summary: `Sent a failed message to ${t.aCustomer} again`, changes: text(metadata.errorCode) ? [`It had failed with: ${text(metadata.errorCode)!.replace(/_/g, " ")}`] : [] };
    case "staff.permission.refused": {
      const permission = typeof metadata.permission === "string" && isPermission(metadata.permission) ? permissionName(metadata.permission, profile) : "an action";
      return { summary: `Was refused: ${permission.toLowerCase()}`, changes: [`Signed in as ${roleName(metadata.role, profile)}`] };
    }
  }
  const signIn = signInAndOrgActions[action];
  if (signIn) {
    const method = text(metadata.method);
    const granted = permissionList(metadata.granted, profile);
    const revoked = permissionList(metadata.revoked, profile);
    return {
      summary: signIn,
      changes: [
        method ? `Method: ${method.replace(/_/g, " ")}` : null,
        granted.length ? `Allowed: ${granted.join(", ")}` : null,
        revoked.length ? `Taken away: ${revoked.join(", ")}` : null,
      ].filter((line): line is string => Boolean(line)),
    };
  }
  const visit = visitActions(t)[action];
  if (visit) return { summary: visit, changes: metadata.source === "public_booking" ? ["From the online booking page"] : [] };
  const record = recordActions(t)[action];
  if (record) return { summary: record, changes: [] };
  const setting = settingsActions(t)[action];
  if (setting) return { summary: setting, changes: [] };
  const recall = /^recall\.status\.(\w+)$/.exec(action);
  if (recall) return { summary: `Marked a recall as ${recall[1].replace(/_/g, " ")}`, changes: [] };
  const waitlist = /^waitlist\.status\.(\w+)$/.exec(action);
  if (waitlist) return { summary: `Marked a waitlist entry as ${waitlist[1].replace(/_/g, " ")}`, changes: [] };
  const status = /^appointment\.status\.(\w+)$/.exec(action);
  if (status) return { summary: `Marked ${t.aVisit} as ${status[1].replace(/_/g, " ")}`, changes: [] };
  return { summary: action, changes: [] };
}

function encodeCursor(row: Row): string {
  return Buffer.from(`${new Date(row.occurred_at).toISOString()}|${row.id}`).toString("base64url");
}

function decodeCursor(cursor: string): { occurredAt: string; id: string } {
  const [occurredAt, id] = Buffer.from(cursor, "base64url").toString().split("|");
  if (!occurredAt || !id || Number.isNaN(Date.parse(occurredAt))) throw new ApiError(400, "invalid_cursor", "That page of activity could not be found.");
  return { occurredAt, id };
}

export interface ActivityFilters {
  category?: ActivityCategory;
  cursor?: string | null;
  /** One person's user id: what they did. */
  actor?: string | undefined;
  /** One kind of event, from `auditActionGroups`, or a single audit action name. */
  action?: string | undefined;
  outcome?: ActivityEntry["outcome"] | undefined;
  /** Inclusive calendar days in the business's own time zone, `YYYY-MM-DD`. */
  from?: string | undefined;
  to?: string | undefined;
  /** Rows per page. The viewer uses the default; the CSV export asks for more. */
  pageSize?: number;
}

/** The action names a filter value stands for: a group such as "failed_sign_in", or one action name. */
export function actionsForFilter(value: string): string[] {
  const group = (auditActionGroups as Record<string, { actions: readonly string[] }>)[value];
  return group ? [...group.actions] : [value];
}

/** Newest first, a page at a time. Routine record listings are left out; every open and change is kept. */
export async function listActivity(
  context: StaffContext,
  options: ActivityFilters = {},
): Promise<ActivityPage> {
  requirePermission(context, "audit.view");
  if (context.preview) return { entries: [], nextCursor: null };
  const category = options.category ?? "all";
  const after = options.cursor ? decodeCursor(options.cursor) : null;
  const limit = options.pageSize ?? pageSize;
  const actions = options.action ? actionsForFilter(options.action) : null;
  return withTenant(context.tenantId, async (transaction) => {
    const [zone] = await transaction.execute<{ timezone: string }>(sql`select timezone from tenants where id = ${context.tenantId}`);
    const timezone = zone?.timezone ?? "UTC";
    const rows = await transaction.execute<Row>(sql`
      select event.id, event.action, event.outcome, event.actor_type, auth_users.name as actor_name,
        event.appointment_id, event.metadata, event.occurred_at,
        support.reason as support_reason,
        exists (select 1 from impersonation_sessions as seen where seen.tenant_id = event.tenant_id and seen.admin_user_id = event.actor_user_id) as by_operator
      from audit_events as event
      left join auth_users on auth_users.id = event.actor_user_id
      left join impersonation_sessions as support on support.tenant_id = event.tenant_id and support.id = event.metadata ->> 'sessionId'
      where event.tenant_id = ${context.tenantId}
        and event.action <> 'record.list'
        ${category === "all" ? sql`` : sql`and ${categoryFilters[category]}`}
        ${options.actor ? sql`and event.actor_user_id = ${options.actor}` : sql``}
        ${actions ? sql`and event.action in (${sql.join(actions.map((name) => sql`${name}`), sql`, `)})` : sql``}
        ${options.outcome ? sql`and event.outcome = ${options.outcome}` : sql``}
        ${options.from ? sql`and event.occurred_at >= (${options.from}::date::timestamp at time zone ${timezone})` : sql``}
        ${options.to ? sql`and event.occurred_at < ((${options.to}::date + 1)::timestamp at time zone ${timezone})` : sql``}
        ${after ? sql`and (event.occurred_at, event.id) < (${after.occurredAt}::timestamptz, ${after.id})` : sql``}
      order by event.occurred_at desc, event.id desc
      limit ${limit + 1}
    `);
    const page = rows.slice(0, limit);
    const profile = await loadBusinessProfileIn(transaction, context.tenantId);
    const t = profileWords(profile);
    return {
      entries: page.map((row) => ({
        id: row.id,
        occurredAt: new Date(row.occurred_at).toISOString(),
        // An operator's own name is never shown to the business, whatever they changed while viewing as it.
        actor: row.actor_type === "patient" ? t.Customer : row.actor_type === "platform_support" || row.by_operator ? "Kalendr support" : row.actor_type === "api_key" ? "API key" : row.actor_name ?? (row.actor_type === "system" ? "Kalendr" : "Staff"),
        ...(row.actor_type === "platform_support" || row.by_operator || row.action.startsWith("support.") ? { support: true } : {}),
        outcome: row.outcome,
        appointmentId: row.appointment_id,
        ...describeActivity(row.action, row.support_reason ? { ...(row.metadata ?? {}), supportReason: row.support_reason } : row.metadata ?? {}, profile),
      })),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    };
  });
}
