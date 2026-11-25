import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

const id = () =>
  text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`);

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow();

const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow();

export const membershipRole = pgEnum("membership_role", [
  "owner",
  "admin",
  "receptionist",
  "practitioner",
  "billing",
  "read_only",
]);

export const bookingMode = pgEnum("booking_mode", ["instant", "request"]);
export const contactChannel = pgEnum("contact_channel", [
  "sms",
  "email",
  "whatsapp",
  "phone",
]);
export const resourceKind = pgEnum("resource_kind", [
  "operatory",
  "room",
  "chair",
  "equipment",
  "space",
  "station",
  "vehicle",
  "other",
]);
export const appointmentStatus = pgEnum("appointment_status", [
  "requested",
  "booked",
  "checked_in",
  "completed",
  "cancelled",
  "no_show",
  "entered_in_error",
  // A request staff turned down, and one nobody answered before its start time (feature 41; `expired` is also a payment hold that ran out, feature 23).
  "declined",
  "expired",
  // Staff asked the customer to choose a new time: the old time is free and the booking waits (feature 42).
  "reschedule_requested",
  // Online payment (feature 23): the time is held while the customer pays.
  "pending_payment",
]);
export const confirmationStatus = pgEnum("confirmation_status", [
  "needs_action",
  "confirmed",
  "declined",
]);
export const bookingSource = pgEnum("booking_source", [
  "online",
  "staff",
  "widget",
  "recall",
  "waitlist",
  "iframe",
  "phone",
  "walk_in",
  "assistant",
]);
export const formStatus = pgEnum("form_status", [
  "not_assigned",
  "not_started",
  "in_progress",
  "submitted",
]);
export const reminderStatus = pgEnum("reminder_status", [
  "not_scheduled",
  "queued",
  "delivered",
  "failed",
]);
export const reservationState = pgEnum("reservation_state", [
  "held",
  "confirmed",
  "released",
]);
export const waitlistStatus = pgEnum("waitlist_status", [
  "active",
  "offered",
  "fulfilled",
  "expired",
  "declined",
]);
export const recallStatus = pgEnum("recall_status", [
  "upcoming",
  "due",
  "overdue",
  "contacted",
  "snoozed",
  "booked",
  "closed",
]);
export const notificationStatus = pgEnum("notification_status", [
  "queued",
  "sending",
  "delivered",
  "failed",
  "cancelled",
]);
export const outboxStatus = pgEnum("outbox_status", [
  "pending",
  "processing",
  "delivered",
  "failed",
  "dead_letter",
]);
export const auditOutcome = pgEnum("audit_outcome", [
  "success",
  "denied",
  "failed",
  // A booking silently turned away by the spam blocklist (feature 44).
  "refused",
]);
export const patientContactKind = pgEnum("patient_contact_kind", ["email", "phone"]);
export const visitRecordKind = pgEnum("visit_record_kind", ["note", "report", "prescription"]);
export const visitRecordStatus = pgEnum("visit_record_status", ["draft", "shared"]);
/** How the front desk was paid. Card and UPI details are never stored, only that one was used. */
export const consentPurpose = pgEnum("consent_purpose", ["appointment_messages", "marketing_messages", "reviews", "records_sharing"]);
export const consentSource = pgEnum("consent_source", ["booking", "portal", "staff", "whatsapp_stop", "sms_stop", "import", "system", "unsubscribe_link"]);
export const dataRequestType = pgEnum("data_request_type", ["export", "erasure", "correction"]);
export const dataRequestStatus = pgEnum("data_request_status", ["requested", "approved", "refused", "processing", "completed", "failed"]);
export const retentionKind = pgEnum("retention_kind", [
  "login_codes",
  "message_log",
  "cancelled_booking_details",
  "finished_outbox",
  "medical_records",
  "billing_records",
]);
export const retentionAction = pgEnum("retention_action", ["delete", "anonymise"]);
export const paymentMethod = pgEnum("payment_method", ["cash", "upi", "card", "bank", "other"]);
export const domainStatus = pgEnum("domain_status", [
  "pending",
  "verified",
  "active",
  "failed",
]);

// Better Auth core tables are intentionally global. Tenant authorization is
// enforced by memberships and is never inferred from a cookie alone.
export const authUsers = pgTable("auth_users", {
  id: id(),
  name: text("name").notNull(),
  email: varchar("email", { length: 254 }).notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // Null until the person chooses their own password (an invited teammate who hasn't accepted yet).
  passwordSetAt: timestamp("password_set_at", { withTimezone: true, mode: "date" }),
  /** The last time this person signed in by any route (password, Google, company sign-in, passkey, magic link). Null means never. An invite is pending while this and passwordSetAt are both null. */
  lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true, mode: "date" }),
  // Set by better-auth's two-factor plugin once an authenticator app is confirmed.
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [uniqueIndex("auth_users_email_uq").on(table.email)]);

export const authSessions = pgTable("auth_sessions", {
  id: id(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" })
    .notNull(),
  token: text("token").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  // When this sign-in last passed a second factor (an authenticator or backup code, or a passkey,
  // which counts as two). Null means it hasn't. Staff access and step-up checks read it.
  secondFactorAt: timestamp("second_factor_at", { withTimezone: true, mode: "date" }),
  userId: text("user_id")
    .notNull()
    .references(() => authUsers.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("auth_sessions_token_uq").on(table.token),
  index("auth_sessions_user_idx").on(table.userId),
]);

export const authAccounts = pgTable("auth_accounts", {
  id: id(),
  // Preserve historical values; Better Auth >=1.7.3 no longer writes issuer.
  issuer: text("issuer"),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", {
    withTimezone: true,
    mode: "date",
  }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
    withTimezone: true,
    mode: "date",
  }),
  scope: text("scope"),
  password: text("password"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("auth_accounts_provider_account_uq").on(
    table.providerId,
    table.accountId,
  ),
  index("auth_accounts_user_idx").on(table.userId),
]);

export const authVerifications = pgTable("auth_verifications", {
  id: id(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" })
    .notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [index("auth_verifications_identifier_idx").on(table.identifier)]);

// Written by better-auth's two-factor plugin. The secret and the backup codes are encrypted by the plugin.
export const authTwoFactors = pgTable("auth_two_factors", {
  id: id(),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  verified: boolean("verified").notNull().default(true),
  failedVerificationCount: integer("failed_verification_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "date" }),
}, (table) => [index("auth_two_factors_user_idx").on(table.userId), index("auth_two_factors_secret_idx").on(table.secret)]);

// Written by @better-auth/passkey. Only the public key is stored.
export const authPasskeys = pgTable("auth_passkeys", {
  id: id(),
  name: text("name"),
  publicKey: text("public_key").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  credentialID: text("credential_id").notNull(),
  counter: integer("counter").notNull(),
  deviceType: text("device_type").notNull(),
  backedUp: boolean("backed_up").notNull(),
  transports: text("transports"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
  aaguid: text("aaguid"),
}, (table) => [
  index("auth_passkeys_user_idx").on(table.userId),
  uniqueIndex("auth_passkeys_credential_uq").on(table.credentialID),
]);

// One row per browser a person has signed in from, keyed by a hash of its user agent, so
// "a new device signed in" is told once. Holds no address and no raw user agent.
export const authKnownDevices = pgTable("auth_known_devices", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  fingerprintHash: varchar("fingerprint_hash", { length: 64 }).notNull(),
  firstSeenAt: createdAt(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [uniqueIndex("auth_known_devices_user_fp_uq").on(table.userId, table.fingerprintHash)]);

export const tenants = pgTable("tenants", {
  id: id(),
  /** Filled from the name by a trigger when left empty, so older code paths that never set it keep working. */
  slug: varchar("slug", { length: 80 }).notNull().default(""),
  name: varchar("name", { length: 160 }).notNull(),
  legalName: varchar("legal_name", { length: 200 }).notNull(),
  phone: varchar("phone", { length: 32 }).notNull(),
  email: varchar("email", { length: 254 }).notNull(),
  timezone: varchar("timezone", { length: 64 }).notNull(),
  /** Where customers' replies to confirmation emails go (feature 50). Only ever set once a one-time code proved the owner can read it. */
  replyToEmail: varchar("reply_to_email", { length: 254 }),
  replyToVerifiedAt: timestamp("reply_to_verified_at", { withTimezone: true, mode: "date" }),
  locale: varchar("locale", { length: 32 }).notNull().default("en-IN"),
  // Which preset of words, starter services and features the business uses. See src/lib/business-types.ts.
  businessType: varchar("business_type", { length: 40 }).notNull().default("healthcare"),
  // Words the owner renamed, keyed by term. Cleaned on read by resolveBusinessProfile.
  terminology: jsonb("terminology").$type<Record<string, unknown>>().notNull().default({}),
  // Features the owner switched on or off, overriding the preset.
  features: jsonb("features").$type<Record<string, unknown>>().notNull().default({}),
  // A short public description shown on the business page.
  about: varchar("about", { length: 1500 }),
  // The "help me choose" questions customers answer before picking who to book. Checked on read by parseStoredGuide.
  guide: jsonb("guide").$type<Record<string, unknown>>(),
  // How the staff workspace is arranged for this business: per page, the order and visibility of
  // sections, columns and actions, and a few view options. Checked on read by parseWorkspaceLayout.
  layout: jsonb("layout").$type<Record<string, unknown>>().notNull().default({}),
  /** ISO 4217 code every price and payment of this business is in. */
  currency: varchar("currency", { length: 3 }).notNull().default("INR"),
  /** Sign-in rules the owner chose, such as { requireSecondFactorForAll: true }. Checked on read by parseSecurityPolicy. */
  securityPolicy: jsonb("security_policy").$type<Record<string, unknown>>().notNull().default({}),
  /** Organisation defaults for new branches and services (feature 53): time zone, clock, week start, message templates. */
  defaults: jsonb("defaults").$type<Record<string, unknown>>().notNull().default({}),
  /** How the booking page writes times: `auto` follows the visitor's locale (feature 39). */
  defaultClock: varchar("default_clock", { length: 4 }).notNull().default("auto"),
  /** 1 is Monday, 7 is Sunday. The booking page's first day of the week unless a service says otherwise. */
  weekStart: smallint("week_start").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  /** Set by a Kalendr operator (feature 15). Public pages show a neutral notice while this is set. Staff can still sign in. */
  pausedAt: timestamp("paused_at", { withTimezone: true, mode: "date" }),
  /** The business's look on public pages and emails (feature 13): accent colour, corner style, hide-badge flag. Checked on read by parseBrand; the logo and cover are media_assets rows. */
  brand: jsonb("brand").$type<Record<string, unknown>>().notNull().default({}),
  /** Set when the business registered through the guided flow (feature 11). Only these businesses get the setup checklist, the tour and the onboarding emails. */
  onboardingStartedAt: timestamp("onboarding_started_at", { withTimezone: true, mode: "date" }),
  /** Search and discovery (feature 29). Off until the owner switches it on: only then do search engines and the /explore directory see the business. */
  listed: boolean("listed").notNull().default(false),
  /** The owner's own page title and description for search results and link previews: `{ title?, description? }`. Checked on read by parseSeo. */
  seo: jsonb("seo").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  uniqueIndex("tenants_slug_uq").on(table.slug),
  check("tenants_reply_to_pair_ck", sql`(${table.replyToEmail} is null) = (${table.replyToVerifiedAt} is null)`),
]);

export const tenantDomains = pgTable("tenant_domains", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  hostname: varchar("hostname", { length: 253 }).notNull(),
  status: domainStatus("status").notNull().default("pending"),
  verificationTokenHash: varchar("verification_token_hash", { length: 64 }),
  verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
  certificateExpiresAt: timestamp("certificate_expires_at", {
    withTimezone: true,
    mode: "date",
  }),
  /** Feature 13: when the records were last looked up, what came back, and how long a pending address keeps being rechecked (72 hours). */
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true, mode: "date" }),
  lastResult: varchar("last_result", { length: 24 }),
  checkUntil: timestamp("check_until", { withTimezone: true, mode: "date" }),
  /** Set when a live address's records stop matching. The address stops being served 7 days later. */
  missingSince: timestamp("missing_since", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  uniqueIndex("tenant_domains_hostname_uq").on(table.hostname),
  unique("tenant_domains_tenant_id_id_uq").on(table.tenantId, table.id),
  index("tenant_domains_tenant_idx").on(table.tenantId),
]);

/** Sites allowed to show the booking widget in a frame (feature 13). Becomes each business's `frame-ancestors` list. */
export const tenantEmbedOrigins = pgTable("tenant_embed_origins", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  /** An https origin, written by `new URL(...).origin` so it is safe to put in a header. */
  origin: varchar("origin", { length: 253 }).notNull(),
  addedBy: text("added_by"),
  createdAt: createdAt(),
}, (table) => [
  unique("tenant_embed_origins_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("tenant_embed_origins_origin_uq").on(table.tenantId, table.origin),
]);

/** Where a business is in the first-run checklist (feature 11). One row per step the owner finished or skipped; a step with no row is still to do. */
export const onboardingProgress = pgTable("onboarding_progress", {
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  /** services, hours, team, test_booking, reminders, brand, share_link, payments, or tour. Checked by onboarding-steps.ts. */
  stepKey: varchar("step_key", { length: 32 }).notNull(),
  /** When the step was first seen done. Kept so the admin console can show where owners drop off. */
  doneAt: timestamp("done_at", { withTimezone: true, mode: "date" }),
  skippedAt: timestamp("skipped_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  primaryKey({ name: "onboarding_progress_pk", columns: [table.tenantId, table.stepKey] }),
  check("onboarding_progress_one_state", sql`not (${table.doneAt} is not null and ${table.skippedAt} is not null)`),
]);

export const memberships = pgTable("memberships", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  role: membershipRole("role").notNull(),
  /** What this person is called in the business, such as "Senior stylist". Optional; it shows under their name and never changes their access. */
  jobTitle: varchar("job_title", { length: 80 }),
  // Per-person changes on top of the role preset, e.g. { "hours.own": true }. See src/lib/permissions.ts.
  permissionOverrides: jsonb("permission_overrides").$type<Record<string, boolean>>().notNull().default({}),
  /** Hold push and email alerts between these two times, minutes after midnight in the business's time zone (feature 56). Both empty is no quiet hours. */
  quietStartMinute: smallint("quiet_start_minute"),
  quietEndMinute: smallint("quiet_end_minute"),
  /** The morning email of the day's bookings. Empty follows the role: on for owners and admins, off for everyone else. */
  digestEnabled: boolean("digest_enabled"),
  /** When it goes, minutes after midnight in the business's time zone. Empty is 07:00. */
  digestMinute: smallint("digest_minute"),
  /** The business's local day of the last digest, so a day is never sent twice. */
  digestSentOn: date("digest_sent_on", { mode: "string" }),
  /** The owner's weekly or monthly summary email: "off", "weekly" or "monthly". Empty follows the role: weekly for owners, off for everyone else. */
  summaryFrequency: varchar("summary_frequency", { length: 8 }),
  /** The first day of the last period a summary went out for, so a period is never sent twice. */
  summarySentFor: date("summary_sent_for", { mode: "string" }),
  invitedAt: timestamp("invited_at", { withTimezone: true, mode: "date" }),
  isActive: boolean("is_active").notNull().default(true),
  /** A custom role (feature 53) replaces the role's preset permissions; `role` stays the built-in base for second-factor and owner rules. */
  customRoleId: text("custom_role_id"),
  /** The id the company's directory uses for this person (SCIM externalId). Never shown outside the owner's own screens. */
  scimExternalId: varchar("scim_external_id", { length: 255 }),
  /** The one owner who may still sign in with a password and second factor when the business requires company sign-in. */
  breakGlass: boolean("break_glass").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({ name: "memberships_custom_role_fk", columns: [table.tenantId, table.customRoleId], foreignColumns: [customRoles.tenantId, customRoles.id] }).onDelete("restrict"),
  uniqueIndex("memberships_break_glass_uq").on(table.tenantId).where(sql`${table.breakGlass}`),
  uniqueIndex("memberships_scim_external_uq").on(table.tenantId, table.scimExternalId).where(sql`${table.scimExternalId} is not null`),
  unique("memberships_tenant_user_uq").on(table.tenantId, table.userId),
  unique("memberships_tenant_id_id_uq").on(table.tenantId, table.id),
  index("memberships_user_idx").on(table.userId),
  check("memberships_quiet_hours_valid", sql`(${table.quietStartMinute} is null and ${table.quietEndMinute} is null) or (${table.quietStartMinute} between 0 and 1439 and ${table.quietEndMinute} between 0 and 1439 and ${table.quietStartMinute} <> ${table.quietEndMinute})`),
  check("memberships_digest_minute_valid", sql`${table.digestMinute} is null or ${table.digestMinute} between 0 and 1439`),
  check("memberships_summary_frequency_valid", sql`${table.summaryFrequency} is null or ${table.summaryFrequency} in ('off', 'weekly', 'monthly')`),
]);

/**
 * An invite to an email that already has a login (one login, many businesses). It waits here until the person signs in and
 * accepts it; only then is a membership made, with these settings. Until then it grants nothing. The team list shows it the
 * same way as an invite to a brand-new email, with the name and email the business typed, so the business can't tell the two
 * apart. `user_id` goes empty if the login is deleted; the row stays until the business cancels it or it expires.
 */
export const staffLoginInvites = pgTable("staff_login_invites", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => authUsers.id, { onDelete: "set null" }),
  /** The user id the business sees for the invite: random like a new person's, never a login's while the invite stands. */
  standInUserId: text("stand_in_user_id").notNull().default(sql`gen_random_uuid()::text`),
  email: varchar("email", { length: 320 }).notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  role: membershipRole("role").notNull(),
  jobTitle: varchar("job_title", { length: 80 }),
  permissionOverrides: jsonb("permission_overrides").$type<Record<string, boolean>>().notNull().default({}),
  customRoleId: text("custom_role_id"),
  /** The locations the membership will be limited to; empty is every location. */
  locationIds: text("location_ids").array().notNull().default(sql`'{}'::text[]`),
  /** The bookable profile the login is linked to once accepted. */
  practitionerId: text("practitioner_id"),
  isActive: boolean("is_active").notNull().default(true),
  invitedAt: timestamp("invited_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  /** The person said no. The business is not told; it keeps seeing the invite as pending until it expires. */
  declinedAt: timestamp("declined_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("staff_login_invites_tenant_user_uq").on(table.tenantId, table.userId),
  unique("staff_login_invites_tenant_id_id_uq").on(table.tenantId, table.id),
  index("staff_login_invites_user_idx").on(table.userId),
]);

export const locations = pgTable("locations", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 160 }).notNull(),
  address: text("address").notNull(),
  city: varchar("city", { length: 120 }).notNull(),
  timezone: varchar("timezone", { length: 64 }).notNull(),
  accessibleEntrance: boolean("accessible_entrance").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("locations_tenant_id_id_uq").on(table.tenantId, table.id),
  index("locations_tenant_idx").on(table.tenantId),
]);

export const patients = pgTable("patients", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "restrict" }),
  firstName: varchar("first_name", { length: 80 }).notNull(),
  lastName: varchar("last_name", { length: 80 }).notNull(),
  phone: varchar("phone", { length: 32 }).notNull(),
  email: varchar("email", { length: 254 }).notNull(),
  dateOfBirth: date("date_of_birth", { mode: "string" }),
  preferredChannel: contactChannel("preferred_channel").notNull(),
  accessibilityNeed: text("accessibility_need"),
  isDependent: boolean("is_dependent").notNull().default(false),
  // When the patient accepted the clinic's privacy notice (online booking), or staff recorded it.
  privacyAcceptedAt: timestamp("privacy_accepted_at", { withTimezone: true, mode: "date" }),
  // When the patient agreed to reminders by text or WhatsApp. Null means email only.
  messagingConsentAt: timestamp("messaging_consent_at", { withTimezone: true, mode: "date" }),
  // Privacy centre (feature 7). For a customer under 18: the parent or guardian who consented. The contact is sealed
  // with the business's data key (purpose patient.guardian-contact); guardianKeyVersion says which key.
  guardianName: varchar("guardian_name", { length: 120 }),
  guardianRelationship: varchar("guardian_relationship", { length: 40 }),
  guardianContactCiphertext: text("guardian_contact_ciphertext"),
  guardianKeyVersion: integer("guardian_key_version").notNull().default(0),
  guardianConsentedAt: timestamp("guardian_consented_at", { withTimezone: true, mode: "date" }),
  // Set when an approved erasure request anonymised this customer. The row stays so invoices and records keep their link.
  erasedAt: timestamp("erased_at", { withTimezone: true, mode: "date" }),
  /** Made by onboarding (feature 11): the owner's own test booking or the sample customers. Removed in one click, and left out of counts and reports. */
  isTest: boolean("is_test").notNull().default(false),
  /** Customer profiles (feature 27). A blocked customer cannot book online: the page says "please call us". Staff see who blocked them and why. */
  blockedAt: timestamp("blocked_at", { withTimezone: true, mode: "date" }),
  blockReason: varchar("block_reason", { length: 200 }),
  blockedByUserId: text("blocked_by_user_id"),
  /** Set when staff merged this profile into another one. The row stays (consents cannot move) with its contact details sealed in the merge snapshot, and is hidden everywhere. */
  mergedIntoId: text("merged_into_id"),
  mergedAt: timestamp("merged_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("patients_tenant_id_id_uq").on(table.tenantId, table.id),
  index("patients_tenant_merged_idx").on(table.tenantId, table.mergedIntoId).where(sql`${table.mergedIntoId} is not null`),
  index("patients_tenant_blocked_idx").on(table.tenantId).where(sql`${table.blockedAt} is not null`),

  index("patients_tenant_name_idx").on(
    table.tenantId,
    table.lastName,
    table.firstName,
  ),
  // Finds a returning patient by the email they booked with.
  index("patients_tenant_email_idx").on(table.tenantId, table.email),
]);

export const services = pgTable("services", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 160 }).notNull(),
  description: text("description").notNull(),
  durationMinutes: smallint("duration_minutes").notNull(),
  bufferBeforeMinutes: smallint("buffer_before_minutes").notNull().default(0),
  bufferAfterMinutes: smallint("buffer_after_minutes").notNull().default(0),
  /** Spacing between offered starts. Empty means "same as the length". */
  slotIntervalMinutes: smallint("slot_interval_minutes").default(15),
  minimumLeadMinutes: integer("minimum_lead_minutes").notNull().default(60),
  maximumAdvanceDays: smallint("maximum_advance_days").notNull().default(90),
  mode: bookingMode("booking_mode").notNull(),
  patientTypes: text("patient_types").array().notNull(),
  requiredResourceKind: resourceKind("required_resource_kind"),
  priceLabel: varchar("price_label", { length: 80 }),
  /** What a visit costs, in the currency's smallest unit (paise). Empty when the price varies. */
  priceMinor: integer("price_minor"),
  /** Online payment at booking (feature 23): `none`, `deposit` (deposit_minor now, the rest at the visit) or `full`. */
  paymentMode: varchar("payment_mode", { length: 8 }).notNull().default("none"),
  depositMinor: integer("deposit_minor"),
  // Optional group name for the business page's category chips.
  category: varchar("category", { length: 60 }),
  isActive: boolean("is_active").notNull().default(true),
  /** Counts up on every edit so two managers saving the same service cannot overwrite each other. */
  version: integer("version").notNull().default(1),
  /** How far ahead customers may book: N days, N open days, or only between two dates. */
  bookingWindowKind: varchar("booking_window_kind", { length: 16 }).notNull().default("rolling_days"),
  bookingWindowFrom: date("booking_window_from", { mode: "string" }),
  bookingWindowThrough: date("booking_window_through", { mode: "string" }),
  /** Slots start this many minutes after the first moment of each working range (0 to 55). */
  startOffsetMinutes: smallint("start_offset_minutes").notNull().default(0),
  /** Names from the calendar palette. Empty means the default colour. */
  colorLight: varchar("color_light", { length: 20 }),
  colorDark: varchar("color_dark", { length: 20 }),
  /** `hidden` services are not listed anywhere but still book from their own link. */
  visibility: varchar("visibility", { length: 8 }).notNull().default("listed"),
  /** The template this service follows and the version it was last brought in line with (feature 48). Both empty for a normal service. */
  templateId: text("template_id"),
  templateVersion: integer("template_version"),
  /** What this service's calendar entries say (feature 50). Templates with `{placeholders}`; empty means the usual wording. */
  customerEventTitle: varchar("customer_event_title", { length: 200 }),
  staffEventTitle: varchar("staff_event_title", { length: 200 }),
  eventDescription: text("event_description"),
  hideNotesInCalendar: boolean("hide_notes_in_calendar").notNull().default(false),
  hideDetailsInCalendar: boolean("hide_details_in_calendar").notNull().default(false),
  slug: varchar("slug", { length: 80 }).notNull(),
  /** A picture from the media library. Checked against the business's own pictures when saved. */
  bannerMediaId: text("banner_media_id"),
  /** Use this schedule's name instead of each person's default ("Home visits"). */
  scheduleId: text("schedule_id"),
  /** Narrows everyone's hours for this service to the overlap with this schedule. */
  restrictionScheduleId: text("restriction_schedule_id"),
  /** One customer may hold at most this many future bookings of the service. Null is no cap (feature 38). */
  maxActivePerCustomer: smallint("max_active_per_customer"),
  /** When capped, offer the customer a link to move one of their bookings instead. */
  offerRescheduleWhenCapped: boolean("offer_reschedule_when_capped").notNull().default(false),
  /** Each person offers only their earliest free slot of the day. */
  firstSlotOnly: boolean("first_slot_only").notNull().default(false),
  /** Offer starts right after (and before) existing bookings first-class, so the day has fewer gaps. */
  optimizedSlots: boolean("optimized_slots").notNull().default(false),
  /** An old reschedule link offers a "Book again" button. */
  rebookFromOldLink: boolean("rebook_from_old_link").notNull().default(true),
  /** Layouts the booking page offers, and the one shown first (feature 39). */
  layoutsEnabled: text("layouts_enabled").array().notNull().default(sql`ARRAY['month','week','column']::text[]`),
  defaultLayout: varchar("default_layout", { length: 8 }).notNull().default("month"),
  /** Show every visitor the branch's time instead of their own. */
  lockTimezone: boolean("lock_timezone").notNull().default(false),
  /** 1 or 7. Null follows the business. */
  weekStart: smallint("week_start"),
  /** Customers may add guests (feature 40). Guests get the confirmation and updates but cannot manage the booking. */
  /** What happens after a booking (feature 52): `kalendr_page` shows the confirmation, `redirect` sends the customer to `redirect_url`. */
  afterBooking: varchar("after_booking", { length: 14 }).notNull().default("kalendr_page"),
  redirectUrl: varchar("redirect_url", { length: 500 }),
  /** Add the booking id, service, start and a signed short-lived summary token to the redirect. Never the customer's name, email or phone. */
  passDetailsOnRedirect: boolean("pass_details_on_redirect").notNull().default(false),
  successMessage: varchar("success_message", { length: 500 }),
  hideSuccessDetails: boolean("hide_success_details").notNull().default(false),
  allowGuests: boolean("allow_guests").notNull().default(false),
  maxGuests: smallint("max_guests").notNull().default(3),
  /** `email_or_phone` (one of them), `email_required`, or `phone_only` (confirmations go by message). */
  contactMode: varchar("contact_mode", { length: 16 }).notNull().default("email_or_phone"),
  /** Confirm the customer's email with a 6-digit code before the booking is taken. */
  verifyEmail: boolean("verify_email").notNull().default(false),
  /** Which bookings wait for staff: `never`, `always`, `short_notice` (within approval_notice_hours of the start) or `free_mail` (feature 41). */
  approvalRule: varchar("approval_rule", { length: 16 }).notNull().default("never"),
  approvalNoticeHours: smallint("approval_notice_hours").notNull().default(24),
  /** On: a waiting request keeps its slot. Off: the slot stays open and approving checks it is still free. */
  requestsHoldSlot: boolean("requests_hold_slot").notNull().default(true),
  /** The address or call details stay out of confirmations until the booking is approved. */
  hideLocationUntilConfirmed: boolean("hide_location_until_confirmed").notNull().default(false),
  /** What customers may do from their manage link, and how late (feature 42). Staff are never held to these. */
  allowCustomerCancel: boolean("allow_customer_cancel").notNull().default(true),
  allowCustomerReschedule: boolean("allow_customer_reschedule").notNull().default(true),
  /** Minutes before the start inside which the customer can no longer cancel. 0 means any time. */
  cancelCutoffMinutes: integer("cancel_cutoff_minutes").notNull().default(0),
  rescheduleCutoffMinutes: integer("reschedule_cutoff_minutes").notNull().default(0),
  /** On: a customer moving a booking sees only the same person's times. Off: anyone who offers the service. */
  rescheduleSamePerson: boolean("reschedule_same_person").notNull().default(true),
  /** Days a customer has to choose a new time after staff ask. Then the booking is cancelled by the system. */
  rescheduleRequestDays: smallint("reschedule_request_days").notNull().default(7),
  /** Who is given a booking (feature 20): `customer_chooses`, `any_available` (priority, then fair share) or `round_robin` (fair share only). */
  assignment: varchar("assignment", { length: 16 }).notNull().default("customer_chooses"),
  /** When the customer has seen someone before and that person is free, give them the booking. */
  preferReturningPerson: boolean("prefer_returning_person").notNull().default(false),
  /** `appointment` is one person at a time; `class` is a group with seats (feature 18). */
  kind: varchar("kind", { length: 12 }).notNull().default("appointment"),
  /** Seats in a session of this class. Set for every class, empty for an appointment service. */
  capacity: smallint("capacity"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("services_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("services_tenant_slug_uq").on(table.tenantId, table.slug),
  check("services_duration_positive", sql`${table.durationMinutes} > 0`),
  check("services_slot_interval_positive", sql`${table.slotIntervalMinutes} > 0`),
  check("services_price_not_negative", sql`${table.priceMinor} >= 0`),
  check("services_payment_mode_valid", sql`${table.paymentMode} in ('none', 'deposit', 'full')`),
  check("services_payment_amounts_valid", sql`${table.paymentMode} = 'none' or (${table.paymentMode} = 'full') or (${table.paymentMode} = 'deposit' and ${table.depositMinor} > 0)`),
  check("services_buffers_range", sql`${table.bufferBeforeMinutes} between 0 and 240 and ${table.bufferAfterMinutes} between 0 and 240`),
  check("services_offset_below_interval", sql`${table.startOffsetMinutes} >= 0 and ${table.startOffsetMinutes} < ${table.slotIntervalMinutes}`),
  check("services_notice_range", sql`${table.minimumLeadMinutes} between 0 and 129600`),
  check("services_window_kind_valid", sql`${table.bookingWindowKind} in ('rolling_days', 'business_days', 'date_range')`),
  check("services_window_dates_ordered", sql`${table.bookingWindowKind} <> 'date_range' or (${table.bookingWindowFrom} is not null and ${table.bookingWindowThrough} is not null and ${table.bookingWindowThrough} >= ${table.bookingWindowFrom})`),
  check("services_visibility_valid", sql`${table.visibility} in ('listed', 'hidden')`),
  check("services_event_description_len", sql`${table.eventDescription} is null or char_length(${table.eventDescription}) <= 1000`),
  foreignKey({
    name: "services_template_fk",
    columns: [table.tenantId, table.templateId],
    foreignColumns: [serviceTemplates.tenantId, serviceTemplates.id],
  }).onDelete("restrict"),
  check("services_template_pair_ck", sql`(${table.templateId} is null) = (${table.templateVersion} is null)`),
  index("services_template_idx").on(table.tenantId, table.templateId).where(sql`${table.templateId} is not null`),
  check("services_approval_rule_valid", sql`${table.approvalRule} in ('never', 'always', 'short_notice', 'free_mail')`),
  check("services_approval_notice_range", sql`${table.approvalNoticeHours} between 1 and 720`),
  check("services_cancel_cutoff_range", sql`${table.cancelCutoffMinutes} between 0 and 43200 and ${table.rescheduleCutoffMinutes} between 0 and 43200`),
  check("services_reschedule_request_days_range", sql`${table.rescheduleRequestDays} between 1 and 60`),
  check("services_kind_valid", sql`${table.kind} in ('appointment', 'class')`),
  check("services_class_capacity", sql`(${table.kind} = 'class' and ${table.capacity} between 1 and 500) or (${table.kind} = 'appointment' and ${table.capacity} is null)`),
  check("services_assignment_valid", sql`${table.assignment} in ('customer_chooses', 'any_available', 'round_robin')`),
  check("services_after_booking_valid", sql`${table.afterBooking} in ('kalendr_page', 'redirect') and (${table.afterBooking} <> 'redirect' or ${table.redirectUrl} is not null)`),
  index("services_tenant_idx").on(table.tenantId),
]);

export const practitioners = pgTable("practitioners", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  authUserId: text("auth_user_id").references(() => authUsers.id, {
    onDelete: "set null",
  }),
  name: varchar("name", { length: 160 }).notNull(),
  title: varchar("title", { length: 120 }).notNull(),
  initials: varchar("initials", { length: 12 }).notNull(),
  specialty: varchar("specialty", { length: 160 }).notNull(),
  photoDataUrl: text("photo_data_url"),
  bio: text("bio"),
  qualifications: varchar("qualifications", { length: 200 }),
  registrationNumber: varchar("registration_number", { length: 60 }),
  experienceYears: smallint("experience_years"),
  languages: varchar("languages", { length: 200 }),
  phone: varchar("phone", { length: 30 }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("practitioners_tenant_id_id_uq").on(table.tenantId, table.id),
  index("practitioners_tenant_idx").on(table.tenantId),
]);

export const resources = pgTable("resources", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  locationId: text("location_id").notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  kind: resourceKind("kind").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    name: "resources_tenant_location_fk",
    columns: [table.tenantId, table.locationId],
    foreignColumns: [locations.tenantId, locations.id],
  }).onDelete("cascade"),
  unique("resources_tenant_id_id_uq").on(table.tenantId, table.id),
  index("resources_location_kind_idx").on(
    table.tenantId,
    table.locationId,
    table.kind,
  ),
]);

export const practitionerLocations = pgTable("practitioner_locations", {
  tenantId: text("tenant_id").notNull(),
  practitionerId: text("practitioner_id").notNull(),
  locationId: text("location_id").notNull(),
}, (table) => [
  primaryKey({
    name: "practitioner_locations_pk",
    columns: [table.tenantId, table.practitionerId, table.locationId],
  }),
  foreignKey({
    name: "practitioner_locations_practitioner_fk",
    columns: [table.tenantId, table.practitionerId],
    foreignColumns: [practitioners.tenantId, practitioners.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "practitioner_locations_location_fk",
    columns: [table.tenantId, table.locationId],
    foreignColumns: [locations.tenantId, locations.id],
  }).onDelete("cascade"),
]);

/**
 * Which locations a team member is limited to. No rows means every location (the default, and always for owners). One
 * row per allowed location; `kalendr_resolve_staff_access` hands the list to `getStaffContext` on every request.
 */
export const membershipLocations = pgTable("membership_locations", {
  tenantId: text("tenant_id").notNull(),
  membershipId: text("membership_id").notNull(),
  locationId: text("location_id").notNull(),
  createdAt: createdAt(),
}, (table) => [
  primaryKey({ name: "membership_locations_pk", columns: [table.tenantId, table.membershipId, table.locationId] }),
  foreignKey({
    name: "membership_locations_membership_fk",
    columns: [table.tenantId, table.membershipId],
    foreignColumns: [memberships.tenantId, memberships.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "membership_locations_location_fk",
    columns: [table.tenantId, table.locationId],
    foreignColumns: [locations.tenantId, locations.id],
  }).onDelete("cascade"),
  index("membership_locations_location_idx").on(table.tenantId, table.locationId),
]);

export const practitionerServices = pgTable("practitioner_services", {
  tenantId: text("tenant_id").notNull(),
  practitionerId: text("practitioner_id").notNull(),
  serviceId: text("service_id").notNull(),
  /** Team routing (feature 20): higher goes first when several people are free. */
  priority: smallint("priority").notNull().default(0),
  /** Share of "anyone" bookings relative to the others: 2 takes twice as many as 1. */
  weight: smallint("weight").notNull().default(1),
}, (table) => [
  primaryKey({
    name: "practitioner_services_pk",
    columns: [table.tenantId, table.practitionerId, table.serviceId],
  }),
  check("practitioner_services_priority_range", sql`${table.priority} between 0 and 100`),
  check("practitioner_services_weight_range", sql`${table.weight} between 1 and 100`),
  foreignKey({
    name: "practitioner_services_practitioner_fk",
    columns: [table.tenantId, table.practitionerId],
    foreignColumns: [practitioners.tenantId, practitioners.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "practitioner_services_service_fk",
    columns: [table.tenantId, table.serviceId],
    foreignColumns: [services.tenantId, services.id],
  }).onDelete("cascade"),
]);

export const serviceLocations = pgTable("service_locations", {
  tenantId: text("tenant_id").notNull(),
  serviceId: text("service_id").notNull(),
  locationId: text("location_id").notNull(),
}, (table) => [
  primaryKey({
    name: "service_locations_pk",
    columns: [table.tenantId, table.serviceId, table.locationId],
  }),
  foreignKey({
    name: "service_locations_service_fk",
    columns: [table.tenantId, table.serviceId],
    foreignColumns: [services.tenantId, services.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "service_locations_location_fk",
    columns: [table.tenantId, table.locationId],
    foreignColumns: [locations.tenantId, locations.id],
  }).onDelete("cascade"),
]);

/** The lengths a service can be booked for, each with its own price. Exactly one is the default. */
export const serviceDurations = pgTable("service_durations", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  serviceId: text("service_id").notNull(),
  minutes: smallint("minutes").notNull(),
  /** In the currency's smallest unit. Empty when the price varies. */
  priceMinor: integer("price_minor"),
  isDefault: boolean("is_default").notNull().default(false),
  sortOrder: smallint("sort_order").notNull().default(0),
  createdAt: createdAt(),
}, (table) => [
  unique("service_durations_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("service_durations_service_minutes_uq").on(table.tenantId, table.serviceId, table.minutes),
  uniqueIndex("service_durations_one_default_uq").on(table.tenantId, table.serviceId).where(sql`${table.isDefault}`),
  check("service_durations_minutes_range", sql`${table.minutes} between 5 and 480`),
  check("service_durations_price_not_negative", sql`${table.priceMinor} >= 0`),
  foreignKey({
    name: "service_durations_service_fk",
    columns: [table.tenantId, table.serviceId],
    foreignColumns: [services.tenantId, services.id],
  }).onDelete("cascade"),
]);

/** Where a service can happen. With several options the customer chooses one on the booking form. */
export const serviceLocationOptions = pgTable("service_location_options", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  serviceId: text("service_id").notNull(),
  /** in_person, we_call, they_call, video or their_address. */
  kind: varchar("kind", { length: 16 }).notNull(),
  /** The branch, for in_person only. */
  locationId: text("location_id"),
  note: varchar("note", { length: 200 }),
  sortOrder: smallint("sort_order").notNull().default(0),
  createdAt: createdAt(),
}, (table) => [
  unique("service_location_options_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("service_location_options_unique_idx").on(table.tenantId, table.serviceId, table.kind, sql`coalesce(${table.locationId}, '')`),
  check("service_location_options_kind_valid", sql`${table.kind} in ('in_person', 'we_call', 'they_call', 'video', 'their_address')`),
  check("service_location_options_branch_matches_kind", sql`(${table.kind} = 'in_person') = (${table.locationId} is not null)`),
  foreignKey({
    name: "service_location_options_service_fk",
    columns: [table.tenantId, table.serviceId],
    foreignColumns: [services.tenantId, services.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "service_location_options_location_fk",
    columns: [table.tenantId, table.locationId],
    foreignColumns: [locations.tenantId, locations.id],
  }).onDelete("cascade"),
]);

export const scheduleBlocks = pgTable("schedule_blocks", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  locationId: text("location_id"),
  practitionerId: text("practitioner_id"),
  startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
  reason: text("reason").notNull().default(""),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("schedule_blocks_tenant_id_id_uq").on(table.tenantId, table.id),
  check("schedule_blocks_time_order_check", sql`${table.endsAt} > ${table.startsAt}`),
  foreignKey({
    name: "schedule_blocks_location_fk",
    columns: [table.tenantId, table.locationId],
    foreignColumns: [locations.tenantId, locations.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "schedule_blocks_practitioner_fk",
    columns: [table.tenantId, table.practitionerId],
    foreignColumns: [practitioners.tenantId, practitioners.id],
  }).onDelete("cascade"),
  index("schedule_blocks_lookup_idx").on(table.tenantId, table.startsAt, table.endsAt),
]);

export const availabilityRules = pgTable("availability_rules", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  locationId: text("location_id").notNull(),
  practitionerId: text("practitioner_id").notNull(),
  /** The named schedule this range belongs to. Left out on insert, a trigger files it under the person's default. */
  scheduleId: text("schedule_id").notNull(),
  dayOfWeek: smallint("day_of_week").notNull(),
  startsAtLocal: time("starts_at_local").notNull(),
  endsAtLocal: time("ends_at_local").notNull(),
  timezone: varchar("timezone", { length: 64 }).notNull(),
  validFrom: date("valid_from", { mode: "string" }).notNull(),
  validThrough: date("valid_through", { mode: "string" }),
  slotIntervalMinutes: smallint("slot_interval_minutes").notNull().default(15),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    name: "availability_rules_location_fk",
    columns: [table.tenantId, table.locationId],
    foreignColumns: [locations.tenantId, locations.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "availability_rules_practitioner_fk",
    columns: [table.tenantId, table.practitionerId],
    foreignColumns: [practitioners.tenantId, practitioners.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "availability_rules_schedule_fk",
    columns: [table.tenantId, table.scheduleId],
    foreignColumns: [availabilitySchedules.tenantId, availabilitySchedules.id],
  }).onDelete("cascade"),
  unique("availability_rules_tenant_id_id_uq").on(table.tenantId, table.id),
  check(
    "availability_rules_day_of_week_check",
    sql`${table.dayOfWeek} between 1 and 7`,
  ),
  check(
    "availability_rules_time_order_check",
    sql`${table.endsAtLocal} > ${table.startsAtLocal}`,
  ),
  index("availability_rules_lookup_idx").on(
    table.tenantId,
    table.locationId,
    table.practitionerId,
    table.dayOfWeek,
  ),
]);

/**
 * A named weekly pattern for one person ("Working hours", "Summer", "Home visits"). The ranges
 * live in `availability_rules` (one row per range and branch), date changes in `availability_overrides`.
 */
export const availabilitySchedules = pgTable("availability_schedules", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  practitionerId: text("practitioner_id").notNull(),
  name: varchar("name", { length: 80 }).notNull(),
  timezone: varchar("timezone", { length: 64 }).notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("availability_schedules_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("availability_schedules_person_name_uq").on(table.tenantId, table.practitionerId, table.name),
  uniqueIndex("availability_schedules_one_default_uq").on(table.tenantId, table.practitionerId).where(sql`${table.isDefault}`),
  foreignKey({
    name: "availability_schedules_practitioner_fk",
    columns: [table.tenantId, table.practitionerId],
    foreignColumns: [practitioners.tenantId, practitioners.id],
  }).onDelete("cascade"),
]);

/** One date that differs from the weekly pattern: other ranges, or `null` for a closed day. */
export const availabilityOverrides = pgTable("availability_overrides", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  scheduleId: text("schedule_id").notNull(),
  date: date("date", { mode: "string" }).notNull(),
  ranges: jsonb("ranges").$type<Array<{ start: string; end: string }> | null>(),
  createdAt: createdAt(),
}, (table) => [
  unique("availability_overrides_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("availability_overrides_schedule_date_uq").on(table.tenantId, table.scheduleId, table.date),
  foreignKey({
    name: "availability_overrides_schedule_fk",
    columns: [table.tenantId, table.scheduleId],
    foreignColumns: [availabilitySchedules.tenantId, availabilitySchedules.id],
  }).onDelete("cascade"),
]);

/** Which country's public holidays close the business, and which of them the owner turned off. */
export const holidaySettings = pgTable("holiday_settings", {
  tenantId: text("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }),
  country: varchar("country", { length: 2 }).notNull(),
  region: varchar("region", { length: 10 }),
  /** `{ "2026": ["12-25", "easter -2"] }`: holiday ids the owner turned off, per year. */
  optedOut: jsonb("opted_out").$type<Record<string, string[]>>().notNull().default({}),
  /** Extra closed days the owner added, for festivals the holiday data does not list. */
  customDays: jsonb("custom_days").$type<Array<{ date: string; name: string }>>().notNull().default([]),
  version: integer("version").notNull().default(1),
  updatedAt: updatedAt(),
});

/** Dates when a person works in another timezone: the weekly pattern is read there. */
export const travelPeriods = pgTable("travel_periods", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  practitionerId: text("practitioner_id").notNull(),
  startsOn: date("starts_on", { mode: "string" }).notNull(),
  endsOn: date("ends_on", { mode: "string" }).notNull(),
  timezone: varchar("timezone", { length: 64 }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  unique("travel_periods_tenant_id_id_uq").on(table.tenantId, table.id),
  check("travel_periods_dates_ordered", sql`${table.endsOn} >= ${table.startsOn}`),
  foreignKey({
    name: "travel_periods_practitioner_fk",
    columns: [table.tenantId, table.practitionerId],
    foreignColumns: [practitioners.tenantId, practitioners.id],
  }).onDelete("cascade"),
]);

/** Out of office. Their slots close; with a cover person, new bookings can go to the cover (feature 20). */
export const timeOff = pgTable("time_off", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  practitionerId: text("practitioner_id").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
  reason: varchar("reason", { length: 16 }).notNull().default("leave"),
  /** Shown on the booking page ("Back on 3 December"). Free text, so never copied into audit metadata. */
  publicNote: varchar("public_note", { length: 200 }),
  coverPractitionerId: text("cover_practitioner_id"),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("time_off_tenant_id_id_uq").on(table.tenantId, table.id),
  check("time_off_time_order", sql`${table.endsAt} > ${table.startsAt}`),
  check("time_off_reason_valid", sql`${table.reason} in ('leave', 'sick', 'training', 'holiday', 'other')`),
  foreignKey({
    name: "time_off_practitioner_fk",
    columns: [table.tenantId, table.practitionerId],
    foreignColumns: [practitioners.tenantId, practitioners.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "time_off_cover_fk",
    columns: [table.tenantId, table.coverPractitionerId],
    foreignColumns: [practitioners.tenantId, practitioners.id],
  }),
  index("time_off_lookup_idx").on(table.tenantId, table.practitionerId, table.startsAt),
]);

export const appointments = pgTable("appointments", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  locationId: text("location_id").notNull(),
  patientId: text("patient_id").notNull(),
  practitionerId: text("practitioner_id").notNull(),
  serviceId: text("service_id").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
  status: appointmentStatus("status").notNull(),
  confirmationStatus: confirmationStatus("confirmation_status")
    .notNull()
    .default("needs_action"),
  bookingSource: bookingSource("booking_source").notNull(),
  formStatus: formStatus("form_status").notNull().default("not_assigned"),
  reminderStatus: reminderStatus("reminder_status")
    .notNull()
    .default("not_scheduled"),
  manageTokenHash: varchar("manage_token_hash", { length: 64 }).notNull(),
  /** The manage token, sealed for the worker so emails can carry the link. Null on rows made before email delivery. */
  manageTokenCiphertext: text("manage_token_ciphertext"),
  /** The link stops opening this booking 30 days after it ends (feature 8). Kept by the appointments_manage_expiry trigger. */
  manageTokenExpiresAt: timestamp("manage_token_expires_at", { withTimezone: true, mode: "date" }),
  notes: text("notes"),
  reasonForVisit: varchar("reason_for_visit", { length: 500 }),
  /** The values of the business's own visit properties, keyed by property id. Empty values are never stored. */
  customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
  // Where an online booking came from: the referring site's host name and campaign tags, never a full URL.
  referrerHost: varchar("referrer_host", { length: 253 }),
  utmSource: varchar("utm_source", { length: 100 }),
  utmMedium: varchar("utm_medium", { length: 100 }),
  utmCampaign: varchar("utm_campaign", { length: 100 }),
  // The customer's answer to "How did you hear about us?", asked once after booking.
  heardFrom: varchar("heard_from", { length: 20 }),
  version: integer("version").notNull().default(1),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
  // Set when the clinic moved this visit because a doctor's hours changed, so the patient can be told.
  clinicMovedFrom: timestamp("clinic_moved_from", { withTimezone: true, mode: "date" }),
  clinicMovedAt: timestamp("clinic_moved_at", { withTimezone: true, mode: "date" }),
  // When the visit moved through the day, set by the front desk from Today.
  checkedInAt: timestamp("checked_in_at", { withTimezone: true, mode: "date" }),
  visitStartedAt: timestamp("visit_started_at", { withTimezone: true, mode: "date" }),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  /** What this visit costs, copied from the service when it is booked so later price changes leave it alone. */
  priceMinor: integer("price_minor"),
  /** How this visit happens, worked out from the chosen way of meeting: in_person, video (a call room) or phone. */
  deliveryMode: varchar("delivery_mode", { length: 10 }).notNull().default("in_person"),
  /** How the visit happens: in_person, we_call, they_call, video or their_address. Empty on older bookings. */
  locationKind: varchar("location_kind", { length: 16 }),
  /** The customer's address when they chose their_address. Sealed with the record key. */
  locationDetail: text("location_detail"),
  /** Guest email addresses, sealed for the worker. Never logged and never in audit metadata (feature 40). */
  guestEmailsCiphertext: text("guest_emails_ciphertext"),
  /** The repeating series this visit belongs to, and its place in the rule (feature 17). Both empty for a single visit. */
  seriesId: text("series_id"),
  seriesIndex: smallint("series_index"),
  /** Why staff declined a request: a fixed code, never free text (feature 41). */
  declineReasonCode: varchar("decline_reason_code", { length: 24 }),
  /** Times the customer offered when asking, up to 10. Staff approve one of them in a click. */
  proposedStarts: timestamp("proposed_starts", { withTimezone: true, mode: "date" }).array(),
  /** Why a booking ended or moved (feature 42). The codes are fixed lists; the notes are sealed and staff-only. */
  cancelReasonCode: varchar("cancel_reason_code", { length: 24 }),
  /** The label of the staff preset used ("Doctor unwell"), copied so history survives the preset being edited. */
  cancelPresetLabel: varchar("cancel_preset_label", { length: 80 }),
  cancelReasonText: text("cancel_reason_text"),
  cancelledBy: varchar("cancelled_by", { length: 10 }),
  rescheduleReasonText: text("reschedule_reason_text"),
  /** When staff asked the customer to choose a new time. Set while the status is `reschedule_requested`. */
  rescheduleRequestedAt: timestamp("reschedule_requested_at", { withTimezone: true, mode: "date" }),
  /** The earlier booking this one replaces, when staff rebooked a cancelled or past visit. */
  rebookedFromId: text("rebooked_from_id"),
  /** When staff marked the customer as not turning up (feature 43). The status is `no_show`. */
  customerNoShowMarkedAt: timestamp("customer_no_show_marked_at", { withTimezone: true, mode: "date" }),
  /** What the customer agreed to before paying (feature 23): the rules and the exact wording shown. Never edited after booking. */
  paymentTerms: jsonb("payment_terms").$type<Record<string, unknown>>(),
  paymentTermsText: text("payment_terms_text"),
  /** Staff reported this booking as spam (feature 44). `silently_refused` is reserved: a refused booking leaves no row. */
  spamState: varchar("spam_state", { length: 16 }).notNull().default("none"),
  /** The special link this booking was made through (feature 45), and the group a combined link booked together. */
  specialLinkId: text("special_link_id"),
  groupRef: text("group_ref"),
  /** The owner's test booking or a sample appointment from onboarding (feature 11). Reports and counts leave these out; they can be removed in one click. */
  isTest: boolean("is_test").notNull().default(false),
  /** A sample appointment from onboarding (feature 11): never messaged, never planned for by workflows or the reminder sweep. Always also `is_test`. */
  isSample: boolean("is_sample").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    name: "appointments_special_link_fk",
    columns: [table.tenantId, table.specialLinkId],
    foreignColumns: [specialLinks.tenantId, specialLinks.id],
  }).onDelete("restrict"),
  index("appointments_special_link_idx").on(table.tenantId, table.specialLinkId).where(sql`${table.specialLinkId} is not null`),
  index("appointments_group_ref_idx").on(table.tenantId, table.groupRef).where(sql`${table.groupRef} is not null`),
  check("appointments_spam_state_valid", sql`${table.spamState} in ('none', 'reported', 'silently_refused')`),
  check("appointments_price_not_negative", sql`${table.priceMinor} >= 0`),
  foreignKey({
    name: "appointments_series_fk",
    columns: [table.tenantId, table.seriesId],
    foreignColumns: [appointmentSeries.tenantId, appointmentSeries.id],
  }).onDelete("restrict"),
  check("appointments_series_pair_ck", sql`(${table.seriesId} is null) = (${table.seriesIndex} is null)`),
  uniqueIndex("appointments_series_index_uq").on(table.tenantId, table.seriesId, table.seriesIndex).where(sql`${table.seriesId} is not null`),
  check("appointments_delivery_mode_valid", sql`${table.deliveryMode} in ('in_person', 'video', 'phone')`),
  // The rebooked-from foreign key is checked against this on every delete, so it needs its own index.
  index("appointments_rebooked_from_idx").on(table.tenantId, table.rebookedFromId).where(sql`${table.rebookedFromId} is not null`),
  check("appointments_cancelled_by_valid", sql`${table.cancelledBy} is null or ${table.cancelledBy} in ('customer', 'staff', 'system')`),
  check("appointments_cancel_reason_valid", sql`${table.cancelReasonCode} is null or ${table.cancelReasonCode} in ('cant_make_it', 'booked_by_mistake', 'found_another_time', 'feeling_better', 'other', 'staff_preset', 'reschedule_expired', 'spam')`),
  foreignKey({
    name: "appointments_rebooked_from_fk",
    columns: [table.tenantId, table.rebookedFromId],
    foreignColumns: [table.tenantId, table.id],
  }),
  check("appointments_proposed_starts_max", sql`${table.proposedStarts} is null or cardinality(${table.proposedStarts}) <= 10`),
  check("appointments_decline_reason_valid", sql`${table.declineReasonCode} is null or ${table.declineReasonCode} in ('fully_booked', 'outside_services', 'need_information', 'other')`),
  foreignKey({
    name: "appointments_location_fk",
    columns: [table.tenantId, table.locationId],
    foreignColumns: [locations.tenantId, locations.id],
  }).onDelete("restrict"),
  foreignKey({
    name: "appointments_patient_fk",
    columns: [table.tenantId, table.patientId],
    foreignColumns: [patients.tenantId, patients.id],
  }).onDelete("restrict"),
  foreignKey({
    name: "appointments_practitioner_fk",
    columns: [table.tenantId, table.practitionerId],
    foreignColumns: [practitioners.tenantId, practitioners.id],
  }).onDelete("restrict"),
  foreignKey({
    name: "appointments_service_fk",
    columns: [table.tenantId, table.serviceId],
    foreignColumns: [services.tenantId, services.id],
  }).onDelete("restrict"),
  unique("appointments_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("appointments_manage_token_hash_uq").on(table.manageTokenHash),
  check("appointments_time_order_check", sql`${table.endsAt} > ${table.startsAt}`),
  check("appointments_version_positive", sql`${table.version} > 0`),
  check(
    "appointments_heard_from_valid",
    sql`${table.heardFrom} is null or ${table.heardFrom} in ('search', 'social', 'friend', 'referral', 'walk_by', 'other')`,
  ),
  index("appointments_dayboard_idx").on(
    table.tenantId,
    table.locationId,
    table.startsAt,
  ),
  // The bookings list pages by (starts_at, id) inside a business, with and without a status or person (feature 43).
  index("appointments_list_idx").on(table.tenantId, table.startsAt, table.id),
  index("appointments_list_status_idx").on(table.tenantId, table.status, table.startsAt, table.id),
  index("appointments_list_person_idx").on(table.tenantId, table.practitionerId, table.startsAt, table.id),
  index("appointments_list_service_idx").on(table.tenantId, table.serviceId, table.startsAt),
  index("appointments_list_customer_idx").on(table.tenantId, table.patientId, table.startsAt),
  index("appointments_routing_idx").on(table.tenantId, table.practitionerId, table.createdAt),
]);

export const resourceReservations = pgTable("resource_reservations", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  /** The visit this holds time for. A class session's reservations have a `classSessionId` instead (feature 18). */
  appointmentId: text("appointment_id"),
  classSessionId: text("class_session_id"),
  practitionerId: text("practitioner_id"),
  resourceId: text("resource_id"),
  startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
  state: reservationState("state").notNull(),
  holdExpiresAt: timestamp("hold_expires_at", {
    withTimezone: true,
    mode: "date",
  }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    name: "resource_reservations_appointment_fk",
    columns: [table.tenantId, table.appointmentId],
    foreignColumns: [appointments.tenantId, appointments.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "resource_reservations_practitioner_fk",
    columns: [table.tenantId, table.practitionerId],
    foreignColumns: [practitioners.tenantId, practitioners.id],
  }).onDelete("restrict"),
  foreignKey({
    name: "resource_reservations_resource_fk",
    columns: [table.tenantId, table.resourceId],
    foreignColumns: [resources.tenantId, resources.id],
  }).onDelete("restrict"),
  unique("resource_reservations_tenant_id_id_uq").on(table.tenantId, table.id),
  check(
    "resource_reservations_subject_check",
    sql`num_nonnulls(${table.practitionerId}, ${table.resourceId}) = 1`,
  ),
  foreignKey({
    name: "resource_reservations_class_session_fk",
    columns: [table.tenantId, table.classSessionId],
    foreignColumns: [classSessions.tenantId, classSessions.id],
  }).onDelete("cascade"),
  check(
    "resource_reservations_owner_check",
    sql`num_nonnulls(${table.appointmentId}, ${table.classSessionId}) = 1`,
  ),
  check(
    "resource_reservations_time_order_check",
    sql`${table.endsAt} > ${table.startsAt}`,
  ),
  index("resource_reservations_appointment_idx").on(
    table.tenantId,
    table.appointmentId,
  ),
]);

export const waitlistEntries = pgTable("waitlist_entries", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  patientId: text("patient_id").notNull(),
  serviceId: text("service_id").notNull(),
  locationId: text("location_id").notNull(),
  preferredPractitionerIds: text("preferred_practitioner_ids")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  dateFrom: date("date_from", { mode: "string" }).notNull(),
  dateTo: date("date_to", { mode: "string" }).notNull(),
  timePreference: varchar("time_preference", { length: 24 }).notNull(),
  status: waitlistStatus("status").notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    name: "waitlist_entries_patient_fk",
    columns: [table.tenantId, table.patientId],
    foreignColumns: [patients.tenantId, patients.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "waitlist_entries_service_fk",
    columns: [table.tenantId, table.serviceId],
    foreignColumns: [services.tenantId, services.id],
  }).onDelete("restrict"),
  foreignKey({
    name: "waitlist_entries_location_fk",
    columns: [table.tenantId, table.locationId],
    foreignColumns: [locations.tenantId, locations.id],
  }).onDelete("restrict"),
  unique("waitlist_entries_tenant_id_id_uq").on(table.tenantId, table.id),
  check("waitlist_entries_date_order_check", sql`${table.dateTo} >= ${table.dateFrom}`),
  index("waitlist_entries_active_idx").on(table.tenantId, table.status),
]);

export const recalls = pgTable("recalls", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  patientId: text("patient_id").notNull(),
  serviceId: text("service_id").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true, mode: "date" }).notNull(),
  status: recallStatus("status").notNull().default("upcoming"),
  lastContactedAt: timestamp("last_contacted_at", {
    withTimezone: true,
    mode: "date",
  }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    name: "recalls_patient_fk",
    columns: [table.tenantId, table.patientId],
    foreignColumns: [patients.tenantId, patients.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "recalls_service_fk",
    columns: [table.tenantId, table.serviceId],
    foreignColumns: [services.tenantId, services.id],
  }).onDelete("restrict"),
  unique("recalls_tenant_id_id_uq").on(table.tenantId, table.id),
  index("recalls_due_idx").on(table.tenantId, table.status, table.dueAt),
]);

/**
 * Booking forms a business builds. Each edit adds a new version row with the same key, so stored responses
 * always point at the exact questions they answered.
 */
export const formDefinitions = pgTable("form_definitions", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  key: varchar("key", { length: 120 }).notNull(),
  version: integer("version").notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  description: text("description").notNull().default(""),
  fields: jsonb("fields").$type<unknown[]>().notNull(),
  isActive: boolean("is_active").notNull().default(true),
  /** False once a newer version replaces this one. */
  isCurrent: boolean("is_current").notNull().default(true),
  appliesToAll: boolean("applies_to_all").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("form_definitions_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("form_definitions_key_version_uq").on(table.tenantId, table.key, table.version),
  check("form_definitions_version_positive", sql`${table.version} > 0`),
  index("form_definitions_current_idx").on(table.tenantId, table.isCurrent, table.isActive),
]);

export const formDefinitionServices = pgTable("form_definition_services", {
  tenantId: text("tenant_id").notNull(),
  formDefinitionId: text("form_definition_id").notNull(),
  serviceId: text("service_id").notNull(),
  /** `{ fieldId: boolean }`: the form's required switch for this service only (feature 40). */
  requiredOverrides: jsonb("required_overrides").$type<Record<string, boolean>>().notNull().default({}),
}, (table) => [
  primaryKey({
    name: "form_definition_services_pk",
    columns: [table.tenantId, table.formDefinitionId, table.serviceId],
  }),
  foreignKey({
    name: "form_definition_services_form_fk",
    columns: [table.tenantId, table.formDefinitionId],
    foreignColumns: [formDefinitions.tenantId, formDefinitions.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "form_definition_services_service_fk",
    columns: [table.tenantId, table.serviceId],
    foreignColumns: [services.tenantId, services.id],
  }).onDelete("cascade"),
]);

export const forms = pgTable("forms", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  appointmentId: text("appointment_id").notNull(),
  patientId: text("patient_id").notNull(),
  definitionKey: varchar("definition_key", { length: 120 }).notNull(),
  definitionVersion: integer("definition_version").notNull(),
  status: formStatus("status").notNull().default("not_started"),
  responseCiphertext: text("response_ciphertext"),
  encryptionKeyVersion: varchar("encryption_key_version", { length: 80 }),
  /** The business data key that sealed response_ciphertext. 0 is the original environment key. */
  keyVersion: integer("key_version").notNull().default(0),
  submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    name: "forms_appointment_fk",
    columns: [table.tenantId, table.appointmentId],
    foreignColumns: [appointments.tenantId, appointments.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "forms_patient_fk",
    columns: [table.tenantId, table.patientId],
    foreignColumns: [patients.tenantId, patients.id],
  }).onDelete("restrict"),
  unique("forms_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("forms_appointment_definition_uq").on(
    table.tenantId,
    table.appointmentId,
    table.definitionKey,
  ),
]);

export const notifications = pgTable("notifications", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  appointmentId: text("appointment_id"),
  channel: contactChannel("channel").notNull(),
  templateKey: varchar("template_key", { length: 120 }).notNull(),
  destinationCiphertext: text("destination_ciphertext").notNull(),
  providerMessageId: text("provider_message_id"),
  semanticKey: varchar("semantic_key", { length: 200 }).notNull(),
  status: notificationStatus("status").notNull().default("queued"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: "date" })
    .notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "date" }),
  failedAt: timestamp("failed_at", { withTimezone: true, mode: "date" }),
  failureCode: varchar("failure_code", { length: 120 }),
  attemptCount: smallint("attempt_count").notNull().default(0),
  /** When the customer opened a WhatsApp message. Kept apart from `status` so the enum stays as it is. */
  readAt: timestamp("read_at", { withTimezone: true, mode: "date" }),
  /** How the provider bills it: utility, marketing, authentication or service. For the usage meter. */
  costCategory: varchar("cost_category", { length: 16 }),
  /** SMS only: billed segments (GSM-7 is 160 characters, Unicode 70). */
  segments: smallint("segments"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    name: "notifications_appointment_fk",
    columns: [table.tenantId, table.appointmentId],
    foreignColumns: [appointments.tenantId, appointments.id],
  }).onDelete("cascade"),
  unique("notifications_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("notifications_semantic_key_uq").on(table.tenantId, table.semanticKey),
  index("notifications_due_idx").on(table.tenantId, table.status, table.scheduledAt),
  index("notifications_provider_message_idx").on(table.providerMessageId),
]);

/**
 * Addresses a provider told us not to send to again: a hard bounce or a spam complaint. The
 * address is kept only as a salted SHA-256 hash; the send path hashes the recipient and checks here first.
 */
export const messageSuppressions = pgTable("message_suppressions", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  channel: contactChannel("channel").notNull(),
  destinationHash: varchar("destination_hash", { length: 64 }).notNull(),
  /** bounced or complained. */
  reason: varchar("reason", { length: 24 }).notNull(),
  notificationId: text("notification_id"),
  createdAt: createdAt(),
}, (table) => [
  unique("message_suppressions_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("message_suppressions_destination_uq").on(table.tenantId, table.channel, table.destinationHash),
  check("message_suppressions_reason_valid", sql`${table.reason} in ('bounced', 'complained')`),
]);

/** Each provider webhook event, once. A repeat delivery of the same event id is ignored. */
export const messageDeliveryEvents = pgTable("message_delivery_events", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 24 }).notNull(),
  providerEventId: varchar("provider_event_id", { length: 120 }).notNull(),
  notificationId: text("notification_id").notNull(),
  eventType: varchar("event_type", { length: 60 }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    name: "message_delivery_events_notification_fk",
    columns: [table.tenantId, table.notificationId],
    foreignColumns: [notifications.tenantId, notifications.id],
  }).onDelete("cascade"),
  unique("message_delivery_events_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("message_delivery_events_event_uq").on(table.tenantId, table.provider, table.providerEventId),
]);

/**
 * Approved provider templates (WhatsApp templates, DLT-registered SMS templates). Not business
 * data: Kalendr's own number and DLT entity send for every business today, so one row serves
 * all and there is no tenant_id. The webhook flips `status` when the provider approves or
 * rejects one. The SMS `body` is the exact approved wording: the adapter sends variables only.
 */
export const messageTemplates = pgTable("message_templates", {
  id: id(),
  channel: contactChannel("channel").notNull(),
  key: varchar("key", { length: 80 }).notNull(),
  language: varchar("language", { length: 16 }).notNull().default("en"),
  /** WhatsApp template name, or the SMS flow name. */
  providerName: varchar("provider_name", { length: 120 }).notNull(),
  /** DLT template id (MSG91 flow id), when the channel has one. */
  providerTemplateId: varchar("provider_template_id", { length: 80 }),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  statusReason: varchar("status_reason", { length: 120 }),
  /** Names of the variables in the order the provider expects them. */
  variables: jsonb("variables").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  /** Quick-reply button labels, in order. */
  buttons: jsonb("buttons").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  /** SMS: the approved wording with {#var#} slots. */
  body: text("body"),
  costCategory: varchar("cost_category", { length: 16 }).notNull().default("utility"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("message_templates_uq").on(table.channel, table.key, table.language),
  check("message_templates_status_valid", sql`${table.status} in ('pending', 'approved', 'rejected', 'paused')`),
  check("message_templates_cost_valid", sql`${table.costCategory} in ('utility', 'marketing', 'authentication', 'service')`),
]);

/** What one business has switched on. WhatsApp and SMS start on; a business that doesn't want them turns them off. */
export const tenantChannelSettings = pgTable("tenant_channel_settings", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  whatsappEnabled: boolean("whatsapp_enabled").notNull().default(true),
  smsEnabled: boolean("sms_enabled").notNull().default(true),
  /** Later: the business's own WhatsApp number (Embedded Signup). Null means Kalendr's shared number. */
  whatsappAccountId: text("whatsapp_account_id"),
  updatedAt: updatedAt(),
});

/** One conversation with one customer on one channel. Staff answer from here. */
export const messageThreads = pgTable("message_threads", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  patientId: text("patient_id").notNull(),
  channel: contactChannel("channel").notNull().default("whatsapp"),
  /** Salted hash of the customer's E.164 number. Lets an incoming message find its business without storing the number twice. */
  contactHash: varchar("contact_hash", { length: 64 }).notNull(),
  whatsappAccountId: text("whatsapp_account_id"),
  assignedToUserId: text("assigned_to_user_id"),
  unreadCount: integer("unread_count").notNull().default(0),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true, mode: "date" }),
  lastInboundAt: timestamp("last_inbound_at", { withTimezone: true, mode: "date" }),
  /** Free-form replies are allowed until this time: 24 hours after the customer last wrote. */
  windowClosesAt: timestamp("window_closes_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    name: "message_threads_patient_fk",
    columns: [table.tenantId, table.patientId],
    foreignColumns: [patients.tenantId, patients.id],
  }).onDelete("cascade"),
  unique("message_threads_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("message_threads_patient_channel_uq").on(table.tenantId, table.patientId, table.channel),
  index("message_threads_inbox_idx").on(table.tenantId, table.lastMessageAt),
  index("message_threads_contact_idx").on(table.contactHash, table.channel),
]);

/** One message in a thread. The text is sealed with the business's data key; template messages hold no text. */
export const threadMessages = pgTable("messages", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  threadId: text("thread_id").notNull(),
  direction: varchar("direction", { length: 8 }).notNull(),
  /** text, template, button (a quick-reply tap) or other (a picture, a voice note). */
  kind: varchar("kind", { length: 12 }).notNull(),
  bodyCiphertext: text("body_ciphertext"),
  keyVersion: integer("key_version"),
  templateKey: varchar("template_key", { length: 80 }),
  providerMessageId: varchar("provider_message_id", { length: 200 }),
  status: varchar("status", { length: 12 }).notNull(),
  failureCode: varchar("failure_code", { length: 120 }),
  appointmentId: text("appointment_id"),
  notificationId: text("notification_id"),
  sentByUserId: text("sent_by_user_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    name: "messages_thread_fk",
    columns: [table.tenantId, table.threadId],
    foreignColumns: [messageThreads.tenantId, messageThreads.id],
  }).onDelete("cascade"),
  unique("messages_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("messages_provider_id_uq").on(table.tenantId, table.providerMessageId),
  index("messages_thread_idx").on(table.tenantId, table.threadId, table.createdAt),
  index("messages_provider_idx").on(table.providerMessageId),
  check("messages_direction_valid", sql`${table.direction} in ('inbound', 'outbound')`),
  check("messages_kind_valid", sql`${table.kind} in ('text', 'template', 'button', 'other')`),
  check("messages_status_valid", sql`${table.status} in ('received', 'queued', 'sent', 'delivered', 'read', 'failed')`),
]);

/**
 * Short links sent in SMS (/m/<code>) that lead to a customer's manage page. Only a hash of the
 * code is stored. The link stops working when the appointment's manage link would.
 */
export const shortLinks = pgTable("short_links", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  appointmentId: text("appointment_id").notNull(),
  codeHash: varchar("code_hash", { length: 64 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({
    name: "short_links_appointment_fk",
    columns: [table.tenantId, table.appointmentId],
    foreignColumns: [appointments.tenantId, appointments.id],
  }).onDelete("cascade"),
  unique("short_links_code_uq").on(table.codeHash),
  unique("short_links_appointment_uq").on(table.tenantId, table.appointmentId),
]);

/**
 * The hash of a manage link that a move replaced. It can never manage the booking again; it only lets the old
 * link say "this booking was moved" and show the new time. `patientId` is who held the booking then.
 */
export const retiredManageTokens = pgTable("retired_manage_tokens", {
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  appointmentId: text("appointment_id").notNull(),
  patientId: text("patient_id").notNull(),
  retiredAt: timestamp("retired_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: "retired_manage_tokens_pk", columns: [table.tenantId, table.tokenHash] }),
  foreignKey({
    name: "retired_manage_tokens_appointment_fk",
    columns: [table.tenantId, table.appointmentId],
    foreignColumns: [appointments.tenantId, appointments.id],
  }).onDelete("cascade"),
  unique("retired_manage_tokens_hash_uq").on(table.tokenHash),
]);

export const outboxEvents = pgTable("outbox_events", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  aggregateType: varchar("aggregate_type", { length: 80 }).notNull(),
  aggregateId: text("aggregate_id").notNull(),
  eventType: varchar("event_type", { length: 120 }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  dedupeKey: varchar("dedupe_key", { length: 200 }).notNull(),
  status: outboxStatus("status").notNull().default("pending"),
  availableAt: timestamp("available_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  lockedAt: timestamp("locked_at", { withTimezone: true, mode: "date" }),
  lockedBy: varchar("locked_by", { length: 120 }),
  attemptCount: smallint("attempt_count").notNull().default(0),
  lastErrorCode: varchar("last_error_code", { length: 120 }),
  // W3C traceparent of the request that queued the event, so the worker's trace links back to it.
  traceParent: varchar("trace_parent", { length: 64 }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("outbox_events_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("outbox_events_dedupe_key_uq").on(table.tenantId, table.dedupeKey),
  index("outbox_events_claim_idx").on(table.status, table.availableAt),
]);

/**
 * One row per running worker process, written every 30 seconds. Not tenant data: it holds
 * the worker's id, mode and build version only, so it has no tenant_id and no row-level security.
 */
export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: varchar("worker_id", { length: 80 }).primaryKey(),
  mode: varchar("mode", { length: 24 }).notNull(),
  version: varchar("version", { length: 80 }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  stoppedAt: timestamp("stopped_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  index("worker_heartbeats_last_seen_idx").on(table.lastSeenAt),
]);

export const auditEvents = pgTable("audit_events", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  appointmentId: text("appointment_id"),
  actorUserId: text("actor_user_id"),
  actorType: varchar("actor_type", { length: 40 }).notNull(),
  action: varchar("action", { length: 160 }).notNull(),
  outcome: auditOutcome("outcome").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
}, (table) => [
  foreignKey({
    name: "audit_events_appointment_fk",
    columns: [table.tenantId, table.appointmentId],
    foreignColumns: [appointments.tenantId, appointments.id],
  }).onDelete("restrict"),
  unique("audit_events_tenant_id_id_uq").on(table.tenantId, table.id),
  index("audit_events_timeline_idx").on(table.tenantId, table.occurredAt),
]);

export const idempotencyKeys = pgTable("idempotency_keys", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  route: varchar("route", { length: 160 }).notNull(),
  key: varchar("key", { length: 160 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  responseStatus: smallint("response_status"),
  responseBody: jsonb("response_body").$type<Record<string, unknown>>(),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" })
    .notNull()
    .default(sql`now() + interval '24 hours'`),
}, (table) => [
  unique("idempotency_keys_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("idempotency_keys_route_key_uq").on(
    table.tenantId,
    table.route,
    table.key,
  ),
  index("idempotency_keys_expiry_idx").on(table.expiresAt),
]);

// Patient accounts are global, like Better Auth users: one verified contact can reach patient records at several
// clinics. They grant nothing by themselves. Reaching a clinic's data always goes through kalendr_portal_people() and
// then a tenant-scoped transaction.
export const patientAccounts = pgTable("patient_accounts", {
  id: id(),
  contactKind: patientContactKind("contact_kind").notNull(),
  contactValue: varchar("contact_value", { length: 254 }).notNull(),
  lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  uniqueIndex("patient_accounts_contact_uq").on(table.contactKind, table.contactValue),
]);

export const patientLoginCodes = pgTable("patient_login_codes", {
  id: id(),
  contactHash: varchar("contact_hash", { length: 64 }).notNull(),
  codeHash: varchar("code_hash", { length: 64 }).notNull(),
  attemptCount: smallint("attempt_count").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
  /** After a wrong code, the next try is refused until this time (feature 8). */
  lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
}, (table) => [
  index("patient_login_codes_contact_idx").on(table.contactHash, table.createdAt),
]);

/**
 * Fixed-window request counters shared by every app server. Keys are SHA-256 hashes of the
 * rule name and the IP, contact, email or token being limited, so no personal data is stored.
 * Not tenant-scoped and not under row-level security, like the customer sign-in tables.
 * Rows for finished windows are deleted nightly (see src/server/rate-limit.ts).
 */
export const rateLimitBuckets = pgTable("rate_limit_buckets", {
  keyHash: varchar("key_hash", { length: 64 }).notNull(),
  windowStart: timestamp("window_start", { withTimezone: true, mode: "date" }).notNull(),
  windowEnd: timestamp("window_end", { withTimezone: true, mode: "date" }).notNull(),
  count: integer("count").notNull().default(1),
}, (table) => [
  primaryKey({ name: "rate_limit_buckets_pk", columns: [table.keyHash, table.windowStart] }),
  index("rate_limit_buckets_window_end_idx").on(table.windowEnd),
  check("rate_limit_buckets_count_positive", sql`${table.count} > 0`),
]);

export const patientSessions = pgTable("patient_sessions", {
  id: id(),
  accountId: text("account_id")
    .notNull()
    .references(() => patientAccounts.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  /** "Chrome on macOS": a coarse label for the devices list (feature 8). */
  deviceLabel: varchar("device_label", { length: 80 }),
  /** True when the customer chose "Remember this device for 30 days". */
  remember: boolean("remember").notNull().default(false),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("patient_sessions_token_uq").on(table.tokenHash),
  index("patient_sessions_account_idx").on(table.accountId),
]);

/** Proof that an account holder is this patient, or may act for them. Without it the portal shows visits only. */
export const patientRecordAccess = pgTable("patient_record_access", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  patientId: text("patient_id").notNull(),
  accountId: text("account_id")
    .notNull()
    .references(() => patientAccounts.id, { onDelete: "cascade" }),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "date" }),
  confirmedMethod: varchar("confirmed_method", { length: 40 }),
  confirmedByUserId: text("confirmed_by_user_id"),
  requestedAt: timestamp("requested_at", { withTimezone: true, mode: "date" }),
  failedAttempts: smallint("failed_attempts").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    name: "patient_record_access_patient_fk",
    columns: [table.tenantId, table.patientId],
    foreignColumns: [patients.tenantId, patients.id],
  }).onDelete("cascade"),
  unique("patient_record_access_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("patient_record_access_person_uq").on(table.tenantId, table.patientId, table.accountId),
]);

export const visitRecords = pgTable("visit_records", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  patientId: text("patient_id").notNull(),
  appointmentId: text("appointment_id"),
  practitionerId: text("practitioner_id"),
  kind: visitRecordKind("kind").notNull(),
  status: visitRecordStatus("status").notNull().default("draft"),
  titleCiphertext: text("title_ciphertext").notNull(),
  bodyCiphertext: text("body_ciphertext").notNull(),
  /** The business data key that sealed the title and body. 0 is the original environment key. */
  keyVersion: integer("key_version").notNull().default(0),
  createdByUserId: text("created_by_user_id"),
  firstSharedAt: timestamp("first_shared_at", { withTimezone: true, mode: "date" }),
  sharedAt: timestamp("shared_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    name: "visit_records_patient_fk",
    columns: [table.tenantId, table.patientId],
    foreignColumns: [patients.tenantId, patients.id],
  }).onDelete("restrict"),
  foreignKey({
    name: "visit_records_appointment_fk",
    columns: [table.tenantId, table.appointmentId],
    foreignColumns: [appointments.tenantId, appointments.id],
  }).onDelete("restrict"),
  foreignKey({
    name: "visit_records_practitioner_fk",
    columns: [table.tenantId, table.practitionerId],
    foreignColumns: [practitioners.tenantId, practitioners.id],
  }).onDelete("restrict"),
  unique("visit_records_tenant_id_id_uq").on(table.tenantId, table.id),
  index("visit_records_patient_idx").on(table.tenantId, table.patientId, table.createdAt),
  index("visit_records_timeline_idx").on(table.tenantId, table.createdAt),
]);

export const visitRecordFiles = pgTable("visit_record_files", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  recordId: text("record_id").notNull(),
  storageKey: text("storage_key").notNull(),
  nameCiphertext: text("name_ciphertext").notNull(),
  contentType: varchar("content_type", { length: 80 }).notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  /** The business data key that sealed the stored object and the name. 0 is the original environment key. */
  keyVersion: integer("key_version").notNull().default(0),
  /** pending until the virus scan finishes; only clean or skipped files can be opened or shared. */
  scanStatus: varchar("scan_status", { length: 16 }).notNull().default("pending"),
  scannedAt: timestamp("scanned_at", { withTimezone: true, mode: "date" }),
  uploadedByUserId: text("uploaded_by_user_id"),
  createdAt: createdAt(),
}, (table) => [
  check("visit_record_files_scan_status_valid", sql`${table.scanStatus} in ('pending', 'clean', 'infected', 'skipped')`),
  foreignKey({
    name: "visit_record_files_record_fk",
    columns: [table.tenantId, table.recordId],
    foreignColumns: [visitRecords.tenantId, visitRecords.id],
  }).onDelete("cascade"),
  unique("visit_record_files_tenant_id_id_uq").on(table.tenantId, table.id),
  index("visit_record_files_record_idx").on(table.tenantId, table.recordId),
]);

/** Raw image bytes. drizzle-orm 0.45 has no built-in bytea column. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * One data key per business and version (envelope encryption). The key itself is only ever
 * stored wrapped by the key provider (a KMS key, or the local master key). Version 0 is the
 * original KALENDR_RECORDS_KEY: it has no row until it is retired, and then a 'legacy' row
 * with retired_at set records that nothing sealed with it may be opened any more.
 */
export const tenantDataKeys = pgTable("tenant_data_keys", {
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  /** legacy (version 0 only), local or kms. */
  provider: varchar("provider", { length: 16 }).notNull(),
  wrappedKey: bytea("wrapped_key"),
  /** Which master key wrapped it: the KMS key id, or a fingerprint of the local master key. */
  masterKeyId: varchar("master_key_id", { length: 2048 }),
  createdAt: createdAt(),
  retiredAt: timestamp("retired_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  primaryKey({ name: "tenant_data_keys_pk", columns: [table.tenantId, table.version] }),
  check("tenant_data_keys_provider_valid", sql`${table.provider} in ('legacy', 'local', 'kms')`),
  check(
    "tenant_data_keys_shape_valid",
    sql`(${table.provider} = 'legacy' and ${table.version} = 0 and ${table.wrappedKey} is null)
      or (${table.provider} <> 'legacy' and ${table.version} > 0 and ${table.wrappedKey} is not null and ${table.masterKeyId} is not null)`,
  ),
]);

/**
 * Public pictures for a business: its logo, its cover, one photo per service
 * and one per practitioner. Replacing a picture deletes the row and inserts a
 * new one, so each id is a permanent, cacheable address. New pictures live in
 * the file store, sealed with the business key; `data` holds only pictures
 * saved before that, until the backfill job moves them.
 */
export const mediaAssets = pgTable("media_assets", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** business_logo, business_cover, service or practitioner. */
  kind: varchar("kind", { length: 24 }).notNull(),
  /** The service or practitioner id for their pictures; the tenant id for business pictures. */
  ownerId: text("owner_id").notNull(),
  contentType: varchar("content_type", { length: 40 }).notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  byteSize: integer("byte_size").notNull(),
  /** Pictures saved before feature 10. Null once the picture lives in the file store. */
  data: bytea("data"),
  storageKey: text("storage_key"),
  /** The business data key that sealed the stored object. Null for pictures still in `data`. */
  keyVersion: integer("key_version"),
  /** Only clean or skipped pictures are served. */
  scanStatus: varchar("scan_status", { length: 16 }).notNull().default("pending"),
  createdAt: createdAt(),
}, (table) => [
  unique("media_assets_tenant_kind_owner_uq").on(table.tenantId, table.kind, table.ownerId),
  check("media_assets_kind_valid", sql`${table.kind} in ('business_logo', 'business_cover', 'service', 'practitioner', 'staff_photo')`),
  check("media_assets_content_type_valid", sql`${table.contentType} in ('image/jpeg', 'image/webp', 'image/png')`),
  check("media_assets_scan_status_valid", sql`${table.scanStatus} in ('pending', 'clean', 'infected', 'skipped')`),
  check("media_assets_bytes_present", sql`${table.data} is not null or (${table.storageKey} is not null and ${table.keyVersion} is not null)`),
]);

/** One customer review of one completed appointment. Hidden reviews never leave the server on public pages. */
export const reviews = pgTable("reviews", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  appointmentId: text("appointment_id").notNull(),
  practitionerId: text("practitioner_id").notNull(),
  serviceId: text("service_id").notNull(),
  rating: smallint("rating").notNull(),
  comment: varchar("comment", { length: 1000 }),
  /** First name and last initial, fixed when the review is written. */
  displayName: varchar("display_name", { length: 60 }).notNull(),
  isHidden: boolean("is_hidden").notNull().default(false),
  /** `public` may show on the business page; `private` is feedback only the business sees (feature 51). Every public reader also requires `is_hidden = false`. */
  visibility: varchar("visibility", { length: 8 }).notNull().default("public"),
  /** How the rating arrived: the manage page, the one-tap rating link, or entered by staff. */
  source: varchar("source", { length: 12 }).notNull().default("manage_link"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  check("reviews_visibility_ck", sql`${table.visibility} in ('public', 'private')`),
  check("reviews_source_ck", sql`${table.source} in ('manage_link', 'rating_link', 'staff')`),
  index("reviews_created_idx").on(table.tenantId, table.createdAt),
  foreignKey({
    name: "reviews_appointment_fk",
    columns: [table.tenantId, table.appointmentId],
    foreignColumns: [appointments.tenantId, appointments.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "reviews_practitioner_fk",
    columns: [table.tenantId, table.practitionerId],
    foreignColumns: [practitioners.tenantId, practitioners.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "reviews_service_fk",
    columns: [table.tenantId, table.serviceId],
    foreignColumns: [services.tenantId, services.id],
  }).onDelete("cascade"),
  unique("reviews_appointment_uq").on(table.tenantId, table.appointmentId),
  check("reviews_rating_range", sql`${table.rating} between 1 and 5`),
  index("reviews_practitioner_idx").on(table.tenantId, table.practitionerId, table.createdAt),
]);

export const schema = {
  reviews,
  patientAccounts,
  patientLoginCodes,
  patientSessions,
  rateLimitBuckets,
  patientRecordAccess,
  visitRecords,
  visitRecordFiles,
  authUsers,
  authSessions,
  authAccounts,
  authVerifications,
  authTwoFactors,
  authPasskeys,
  authKnownDevices,
  tenants,
  tenantDomains,
  tenantEmbedOrigins,
  onboardingProgress,
  memberships,
  locations,
  patients,
  services,
  practitioners,
  resources,
  practitionerLocations,
  practitionerServices,
  serviceLocations,
  availabilityRules,
  scheduleBlocks,
  appointments,
  resourceReservations,
  waitlistEntries,
  recalls,
  forms,
  notifications,
  outboxEvents,
  auditEvents,
  idempotencyKeys,
  mediaAssets,
  tenantDataKeys,
};

export type KalendrSchema = typeof schema;
export type AppointmentRecord = typeof appointments.$inferSelect;
export type NewAppointmentRecord = typeof appointments.$inferInsert;

/** A short note one shift leaves for the next, shown on Today. */
export const handoverNotes = pgTable("handover_notes", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  authorUserId: text("author_user_id"),
  /** The author's name when the note was written, so it reads right after they leave. */
  authorName: varchar("author_name", { length: 120 }).notNull(),
  body: varchar("body", { length: 280 }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  index("handover_notes_tenant_created_idx").on(table.tenantId, table.createdAt),
]);

/**
 * The last token number issued at a location on one day. Locking this row is how two desks
 * never hand out the same number. Numbers start again at 1 each day.
 */
export const queueCounters = pgTable("queue_counters", {
  tenantId: text("tenant_id").notNull(),
  locationId: text("location_id").notNull(),
  day: date("day", { mode: "string" }).notNull(),
  lastNumber: integer("last_number").notNull().default(0),
  /** Set when the desk closes the day: nobody new can join from the door, and those still waiting were let go. */
  closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
  closedReason: varchar("closed_reason", { length: 200 }),
}, (table) => [
  primaryKey({ name: "queue_counters_pk", columns: [table.tenantId, table.locationId, table.day] }),
  foreignKey({
    name: "queue_counters_location_fk",
    columns: [table.tenantId, table.locationId],
    foreignColumns: [locations.tenantId, locations.id],
  }).onDelete("cascade"),
]);

/**
 * A customer's place in today's queue. Every ticket belongs to a visit: a booked customer gets one
 * when they check in, and a walk-in gets one when the desk adds them. Where they are in the visit
 * (waiting, in the room, done, left) is the visit's own status; the ticket adds the call and order.
 */
export const queueTickets = pgTable("queue_tickets", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  locationId: text("location_id").notNull(),
  day: date("day", { mode: "string" }).notNull(),
  number: integer("number").notNull(),
  appointmentId: text("appointment_id").notNull(),
  /** Seen first. Who marked it and why are kept with it. */
  urgent: boolean("urgent").notNull().default(false),
  urgentReason: varchar("urgent_reason", { length: 200 }),
  urgentByUserId: text("urgent_by_user_id"),
  calledAt: timestamp("called_at", { withTimezone: true, mode: "date" }),
  callCount: integer("call_count").notNull().default(0),
  /** When they did not answer a call. Skipped tickets wait behind everyone else. */
  skippedAt: timestamp("skipped_at", { withTimezone: true, mode: "date" }),
  /** The customer's own link to their place in the queue, stored hashed. Making a new link replaces it. */
  phoneTokenHash: varchar("phone_token_hash", { length: 64 }),
  /** The customer asked for a message when they are almost next. */
  notifyWhenNext: boolean("notify_when_next").notNull().default(false),
  nextNotifiedAt: timestamp("next_notified_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("queue_tickets_phone_token_uq").on(table.phoneTokenHash),
  foreignKey({
    name: "queue_tickets_location_fk",
    columns: [table.tenantId, table.locationId],
    foreignColumns: [locations.tenantId, locations.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "queue_tickets_appointment_fk",
    columns: [table.tenantId, table.appointmentId],
    foreignColumns: [appointments.tenantId, appointments.id],
  }).onDelete("cascade"),
  unique("queue_tickets_number_uq").on(table.tenantId, table.locationId, table.day, table.number),
  unique("queue_tickets_appointment_uq").on(table.tenantId, table.appointmentId),
  check("queue_tickets_number_positive", sql`${table.number} > 0`),
  index("queue_tickets_day_idx").on(table.tenantId, table.locationId, table.day),
]);

/**
 * The secret link a waiting-room screen opens to show who is being called. It shows token numbers
 * and who they go to, never customer names. Stored hashed; making a new link turns the old one off.
 */
export const queueDisplays = pgTable("queue_displays", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  locationId: text("location_id").notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  /** The door QR code's link (feature 22), stored hashed. It lives on the location's live row and moves with it when the screen link is replaced. */
  joinTokenHash: varchar("join_token_hash", { length: 64 }),
  /** Customers may join the queue from their own phone at the door. Staff turn this off to stop walk-up sign-ups. */
  selfJoinEnabled: boolean("self_join_enabled").notNull().default(true),
  createdByUserId: text("created_by_user_id"),
  createdAt: createdAt(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  uniqueIndex("queue_displays_join_token_uq").on(table.joinTokenHash),
  foreignKey({
    name: "queue_displays_location_fk",
    columns: [table.tenantId, table.locationId],
    foreignColumns: [locations.tenantId, locations.id],
  }).onDelete("cascade"),
  uniqueIndex("queue_displays_token_uq").on(table.tokenHash),
  uniqueIndex("queue_displays_live_uq").on(table.tenantId, table.locationId).where(sql`${table.revokedAt} is null`),
]);

/**
 * Money taken at the desk for a visit. A payment is never changed: a mistake or a refund is
 * its own row in `payment_refunds`. Only the method is kept, never card or UPI details.
 */
export const payments = pgTable("payments", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  /** Empty only for a sale with no visit, such as a package: then `patientId` and `locationId` say whose money it is and where it was taken. */
  appointmentId: text("appointment_id"),
  patientId: text("patient_id"),
  locationId: text("location_id"),
  /** The invoice a visit-less sale was paid against. Visit payments find theirs through the visit. */
  invoiceId: text("invoice_id"),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  method: paymentMethod("method").notNull(),
  recordedByUserId: text("recorded_by_user_id"),
  /** Online payments only (feature 23): who took it and its id there. Both empty for money taken at the desk. */
  provider: varchar("provider", { length: 12 }),
  providerPaymentId: varchar("provider_payment_id", { length: 80 }),
  orderId: text("order_id"),
  /** Taken with a test-mode account. Test money never reaches the day close or reports. */
  isTest: boolean("is_test").notNull().default(false),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({
    name: "payments_appointment_fk",
    columns: [table.tenantId, table.appointmentId],
    foreignColumns: [appointments.tenantId, appointments.id],
  }).onDelete("restrict"),
  foreignKey({ name: "payments_patient_fk", columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id] }).onDelete("restrict"),
  foreignKey({ name: "payments_location_fk", columns: [table.tenantId, table.locationId], foreignColumns: [locations.tenantId, locations.id] }).onDelete("restrict"),
  foreignKey({ name: "payments_invoice_fk", columns: [table.tenantId, table.invoiceId], foreignColumns: [invoices.tenantId, invoices.id] }).onDelete("restrict"),
  check("payments_target_ck", sql`${table.appointmentId} is not null or (${table.patientId} is not null and ${table.locationId} is not null)`),
  unique("payments_tenant_id_id_uq").on(table.tenantId, table.id),
  check("payments_amount_positive", sql`${table.amountMinor} > 0`),
  uniqueIndex("payments_provider_payment_uq").on(table.tenantId, table.provider, table.providerPaymentId).where(sql`${table.providerPaymentId} is not null`),
  index("payments_appointment_idx").on(table.tenantId, table.appointmentId),
  index("payments_created_idx").on(table.tenantId, table.createdAt),
]);

/** Money given back against one payment. Together they never exceed the payment. */
export const paymentRefunds = pgTable("payment_refunds", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  paymentId: text("payment_id").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  reason: varchar("reason", { length: 200 }).notNull(),
  recordedByUserId: text("recorded_by_user_id"),
  /** Online refunds only (feature 23): the request that asked for it and the provider's id once it paid out. */
  requestId: text("request_id"),
  providerRefundId: varchar("provider_refund_id", { length: 80 }),
  isTest: boolean("is_test").notNull().default(false),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({
    name: "payment_refunds_payment_fk",
    columns: [table.tenantId, table.paymentId],
    foreignColumns: [payments.tenantId, payments.id],
  }).onDelete("restrict"),
  check("payment_refunds_amount_positive", sql`${table.amountMinor} > 0`),
  uniqueIndex("payment_refunds_provider_refund_uq").on(table.tenantId, table.providerRefundId).where(sql`${table.providerRefundId} is not null`),
  uniqueIndex("payment_refunds_request_uq").on(table.tenantId, table.requestId).where(sql`${table.requestId} is not null`),
  index("payment_refunds_payment_idx").on(table.tenantId, table.paymentId),
]);

/** What a closed day looked like. Shape is `DaySummary` in src/server/day-end.ts. */
export type DayCloseSummary = Record<string, unknown>;

/**
 * One closed day per location. Written once when the desk closes the day and never changed,
 * so the totals the owner saw that night stay the totals on record.
 */
export const dayCloses = pgTable("day_closes", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  locationId: text("location_id").notNull(),
  day: date("day", { mode: "string" }).notNull(),
  /** Visits and money for the day as they stood at closing. */
  summary: jsonb("summary").$type<DayCloseSummary>().notNull(),
  cashExpectedMinor: integer("cash_expected_minor").notNull(),
  cashCountedMinor: integer("cash_counted_minor").notNull(),
  note: varchar("note", { length: 300 }),
  closedByUserId: text("closed_by_user_id"),
  closedByName: varchar("closed_by_name", { length: 120 }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({
    name: "day_closes_location_fk",
    columns: [table.tenantId, table.locationId],
    foreignColumns: [locations.tenantId, locations.id],
  }).onDelete("restrict"),
  unique("day_closes_location_day_uq").on(table.tenantId, table.locationId, table.day),
  check("day_closes_cash_not_negative", sql`${table.cashCountedMinor} >= 0 and ${table.cashExpectedMinor} >= 0`),
]);

/** A hand-picked pool of people whose bookings count together for a limit, until teams arrive (feature 53). */
export const limitTeams = pgTable("limit_teams", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  name: varchar("name", { length: 80 }).notNull(),
  createdAt: createdAt(),
}, (table) => [unique("limit_teams_tenant_id_id_uq").on(table.tenantId, table.id)]);

export const limitTeamMembers = pgTable("limit_team_members", {
  tenantId: text("tenant_id").notNull(),
  teamId: text("team_id").notNull(),
  practitionerId: text("practitioner_id").notNull(),
}, (table) => [
  primaryKey({ name: "limit_team_members_pk", columns: [table.tenantId, table.teamId, table.practitionerId] }),
  foreignKey({ name: "limit_team_members_team_fk", columns: [table.tenantId, table.teamId], foreignColumns: [limitTeams.tenantId, limitTeams.id] }).onDelete("cascade"),
  foreignKey({ name: "limit_team_members_practitioner_fk", columns: [table.tenantId, table.practitionerId], foreignColumns: [practitioners.tenantId, practitioners.id] }).onDelete("cascade"),
]);

/**
 * A cap on bookings or booked minutes per day, week, month or year (feature 38). One column names the owner,
 * chosen by `scope`; the database checks that exactly that one is set so each foreign key stays composite.
 */
export const bookingLimits = pgTable("booking_limits", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  scope: varchar("scope", { length: 16 }).notNull(),
  serviceId: text("service_id"),
  practitionerId: text("practitioner_id"),
  locationId: text("location_id"),
  resourceId: text("resource_id"),
  teamId: text("team_id"),
  measure: varchar("measure", { length: 8 }).notNull(),
  period: varchar("period", { length: 8 }).notNull(),
  maxValue: integer("max_value").notNull(),
  /** 1 is Monday, 7 is Sunday. Weekly limits restart on this day in the business's timezone. */
  weekStart: smallint("week_start").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("booking_limits_tenant_id_id_uq").on(table.tenantId, table.id),
  check("booking_limits_max_positive", sql`${table.maxValue} > 0`),
  foreignKey({ name: "booking_limits_service_fk", columns: [table.tenantId, table.serviceId], foreignColumns: [services.tenantId, services.id] }).onDelete("cascade"),
  foreignKey({ name: "booking_limits_practitioner_fk", columns: [table.tenantId, table.practitionerId], foreignColumns: [practitioners.tenantId, practitioners.id] }).onDelete("cascade"),
  foreignKey({ name: "booking_limits_location_fk", columns: [table.tenantId, table.locationId], foreignColumns: [locations.tenantId, locations.id] }).onDelete("cascade"),
  foreignKey({ name: "booking_limits_resource_fk", columns: [table.tenantId, table.resourceId], foreignColumns: [resources.tenantId, resources.id] }).onDelete("cascade"),
  foreignKey({ name: "booking_limits_team_fk", columns: [table.tenantId, table.teamId], foreignColumns: [limitTeams.tenantId, limitTeams.id] }).onDelete("cascade"),
]);

/**
 * A time kept for one customer for a few minutes while they fill in the booking form (feature 39).
 * The slot engine reads a live hold as busy time; the token is 256-bit and only its hash is stored.
 */
export const slotHolds = pgTable("slot_holds", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  serviceId: text("service_id").notNull(),
  practitionerId: text("practitioner_id").notNull(),
  locationId: text("location_id").notNull(),
  resourceId: text("resource_id"),
  startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
  reservedStartsAt: timestamp("reserved_starts_at", { withTimezone: true, mode: "date" }).notNull(),
  reservedEndsAt: timestamp("reserved_ends_at", { withTimezone: true, mode: "date" }).notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  /** `booking` while the form is open. Feature 23 adds `payment`. */
  purpose: varchar("purpose", { length: 16 }).notNull().default("booking"),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  unique("slot_holds_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("slot_holds_token_uq").on(table.tokenHash),
  foreignKey({ name: "slot_holds_service_fk", columns: [table.tenantId, table.serviceId], foreignColumns: [services.tenantId, services.id] }).onDelete("cascade"),
  foreignKey({ name: "slot_holds_practitioner_fk", columns: [table.tenantId, table.practitionerId], foreignColumns: [practitioners.tenantId, practitioners.id] }).onDelete("cascade"),
  foreignKey({ name: "slot_holds_location_fk", columns: [table.tenantId, table.locationId], foreignColumns: [locations.tenantId, locations.id] }).onDelete("cascade"),
  foreignKey({ name: "slot_holds_resource_fk", columns: [table.tenantId, table.resourceId], foreignColumns: [resources.tenantId, resources.id] }).onDelete("cascade"),
  index("slot_holds_person_expiry_idx").on(table.tenantId, table.practitionerId, table.expiresAt),
  index("slot_holds_expiry_idx").on(table.expiresAt),
]);

/** A code sent to confirm an email address before a booking is taken (feature 40). Only hashes are kept. */
export const emailChecks = pgTable("email_checks", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  emailHash: varchar("email_hash", { length: 64 }).notNull(),
  codeHash: varchar("code_hash", { length: 64 }).notNull(),
  /** The address and code, sealed for the worker to send. Cleared once sent. */
  deliverySealed: text("delivery_sealed"),
  attempts: smallint("attempts").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
  /** SHA-256 of the proof the page sends with the booking. Single use. */
  proofHash: varchar("proof_hash", { length: 64 }),
  consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
}, (table) => [
  unique("email_checks_tenant_id_id_uq").on(table.tenantId, table.id),
  index("email_checks_email_idx").on(table.tenantId, table.emailHash, table.createdAt),
]);

/**
 * One row per business for message workflows: when quiet hours run, and whether the standard set of
 * reminders has been switched on. Once `presetsAppliedAt` is set the workflow engine owns reminders and
 * review requests, and the older fixed 24-hour reminder and fixed review request stand down.
 */
export const workflowSettings = pgTable("workflow_settings", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** Minutes after local midnight. A message due between start and end waits until end. */
  quietStartMinute: smallint("quiet_start_minute").notNull().default(1260),
  quietEndMinute: smallint("quiet_end_minute").notNull().default(480),
  presetsAppliedAt: timestamp("presets_applied_at", { withTimezone: true, mode: "date" }),
  /** Empty means workflows changed since the last full pass, so the worker re-plans every upcoming booking. */
  reconciledAt: timestamp("reconciled_at", { withTimezone: true, mode: "date" }),
  updatedAt: updatedAt(),
}, (table) => [
  check("workflow_settings_minutes_valid", sql`${table.quietStartMinute} between 0 and 1439 and ${table.quietEndMinute} between 0 and 1439`),
]);

export type WorkflowFiltersRecord = {
  serviceIds: string[];
  locationIds: string[];
  practitionerIds: string[];
  bookingSources: string[];
};

/** A rule: "when this happens to a booking, send these messages". Filters narrow it to some services, places or people. */
export const workflows = pgTable("workflows", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 160 }).notNull(),
  trigger: varchar("trigger", { length: 24 }).notNull(),
  /** Minutes before the start (before_start, form_missing) or after the end (after_end). Zero for the rest. */
  offsetMinutes: integer("offset_minutes").notNull().default(0),
  filters: jsonb("filters").$type<WorkflowFiltersRecord>().notNull().default(sql`'{}'::jsonb`),
  active: boolean("active").notNull().default(true),
  /** Which standard workflow this started as, so "turn on the standard set" never adds it twice. */
  presetKey: varchar("preset_key", { length: 40 }),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("workflows_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("workflows_tenant_preset_uq").on(table.tenantId, table.presetKey).where(sql`${table.presetKey} is not null`),
  check(
    "workflows_trigger_valid",
    sql`${table.trigger} in ('booked', 'requested', 'rescheduled', 'cancelled', 'before_start', 'after_end', 'no_show', 'form_missing', 'checked_in')`,
  ),
  check("workflows_offset_range", sql`${table.offsetMinutes} between 0 and 86400`),
  index("workflows_tenant_active_idx").on(table.tenantId, table.active, table.trigger),
]);

/** One message in a workflow. Waits add up: step two sends its wait after step one's time. */
export const workflowSteps = pgTable("workflow_steps", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  workflowId: text("workflow_id").notNull(),
  position: smallint("position").notNull(),
  /** A plain key such as email, whatsapp or sms. The worker looks the sender up by this key. */
  channel: varchar("channel", { length: 24 }).notNull(),
  subject: varchar("subject", { length: 200 }).notNull().default(""),
  body: text("body").notNull(),
  /** The approved message a WhatsApp or text step sends (reminder, booking_confirmed…). Empty for email, which has its own words. */
  templateKey: varchar("template_key", { length: 40 }),
  waitMinutes: integer("wait_minutes").notNull().default(0),
  ignoreQuietHours: boolean("ignore_quiet_hours").notNull().default(false),
  skipIfConfirmed: boolean("skip_if_confirmed").notNull().default(false),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({
    name: "workflow_steps_workflow_fk",
    columns: [table.tenantId, table.workflowId],
    foreignColumns: [workflows.tenantId, workflows.id],
  }).onDelete("cascade"),
  unique("workflow_steps_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("workflow_steps_position_uq").on(table.tenantId, table.workflowId, table.position),
  check("workflow_steps_wait_range", sql`${table.waitMinutes} between 0 and 86400`),
  check("workflow_steps_body_length", sql`char_length(${table.body}) <= 2000 and (char_length(${table.body}) >= 1 or ${table.templateKey} is not null)`),
]);

/**
 * A message waiting for its time. `slotKey` says which moment it was planned for (`t:<epoch>` for timed
 * triggers, `e:<event>:<version>` for events), so planning the same booking twice adds nothing, a booking
 * moved away and back revives its old row, and a reminder already sent is never sent again.
 */
export const scheduledMessages = pgTable("scheduled_messages", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  appointmentId: text("appointment_id").notNull(),
  workflowId: text("workflow_id").notNull(),
  stepId: text("step_id").notNull(),
  slotKey: varchar("slot_key", { length: 80 }).notNull(),
  appointmentVersion: integer("appointment_version").notNull(),
  sendAt: timestamp("send_at", { withTimezone: true, mode: "date" }).notNull(),
  /** pending, queued (handed to the worker), sent, skipped (chose not to send) or cancelled (booking changed). */
  status: varchar("status", { length: 12 }).notNull().default("pending"),
  /** A short code for why a message was skipped or cancelled. Never any customer content. */
  reason: varchar("reason", { length: 40 }),
  sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    name: "scheduled_messages_appointment_fk",
    columns: [table.tenantId, table.appointmentId],
    foreignColumns: [appointments.tenantId, appointments.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "scheduled_messages_step_fk",
    columns: [table.tenantId, table.stepId],
    foreignColumns: [workflowSteps.tenantId, workflowSteps.id],
  }).onDelete("cascade"),
  unique("scheduled_messages_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("scheduled_messages_slot_uq").on(table.tenantId, table.appointmentId, table.stepId, table.slotKey),
  check("scheduled_messages_status_valid", sql`${table.status} in ('pending', 'queued', 'sent', 'skipped', 'cancelled', 'failed')`),
  index("scheduled_messages_due_idx").on(table.status, table.sendAt),
  index("scheduled_messages_appointment_idx").on(table.tenantId, table.appointmentId, table.status),
]);

/**
 * The call room for one video visit. The worker makes it shortly before the start and it expires soon after
 * the end. Nothing here is a secret: meeting tokens are made per person at join time and never stored.
 * The presence columns drive the waiting room and "Dr Rao has not joined yet".
 */
export const videoRooms = pgTable("video_rooms", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  appointmentId: text("appointment_id").notNull(),
  /** daily or fake (local test mode). */
  provider: varchar("provider", { length: 12 }).notNull(),
  providerRoomName: varchar("provider_room_name", { length: 120 }).notNull(),
  roomUrl: text("room_url").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  /** active, or ended once the booking was cancelled or moved and the room was closed. */
  status: varchar("status", { length: 10 }).notNull().default("active"),
  staffJoinedAt: timestamp("staff_joined_at", { withTimezone: true, mode: "date" }),
  /** Last heartbeat from the staff member's call screen. Someone is "here" while this is under a minute old. */
  staffSeenAt: timestamp("staff_seen_at", { withTimezone: true, mode: "date" }),
  customerWaitingAt: timestamp("customer_waiting_at", { withTimezone: true, mode: "date" }),
  customerAdmittedAt: timestamp("customer_admitted_at", { withTimezone: true, mode: "date" }),
  customerJoinedAt: timestamp("customer_joined_at", { withTimezone: true, mode: "date" }),
  customerSeenAt: timestamp("customer_seen_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    name: "video_rooms_appointment_fk",
    columns: [table.tenantId, table.appointmentId],
    foreignColumns: [appointments.tenantId, appointments.id],
  }).onDelete("cascade"),
  unique("video_rooms_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("video_rooms_appointment_uq").on(table.tenantId, table.appointmentId),
  check("video_rooms_status_valid", sql`${table.status} in ('active', 'ended')`),
]);

// ---------------------------------------------------------------------------------------------
// Privacy centre (feature 7)
// ---------------------------------------------------------------------------------------------

/**
 * Every consent given or withdrawn, once. Rows are never changed or removed (a trigger refuses it),
 * so the history proves what a customer agreed to and when. Holds ids and a fixed vocabulary only:
 * no names, contacts or free text. The latest row for a purpose is the current answer.
 */
export const consentRecords = pgTable("consent_records", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  patientId: text("patient_id").notNull(),
  purpose: consentPurpose("purpose").notNull(),
  granted: boolean("granted").notNull(),
  /** The version of the notice the customer saw, such as "2026-11". */
  wordingVersion: varchar("wording_version", { length: 40 }).notNull(),
  source: consentSource("source").notNull(),
  /** patient, guardian, staff, system or provider. Who acted is a fixed word, never typed text. */
  actorType: varchar("actor_type", { length: 20 }).notNull(),
  actorUserId: text("actor_user_id"),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({
    name: "consent_records_patient_fk",
    columns: [table.tenantId, table.patientId],
    foreignColumns: [patients.tenantId, patients.id],
  }).onDelete("restrict"),
  unique("consent_records_tenant_id_id_uq").on(table.tenantId, table.id),
  check("consent_records_actor_valid", sql`${table.actorType} in ('patient', 'guardian', 'staff', 'system', 'provider')`),
  index("consent_records_latest_idx").on(table.tenantId, table.patientId, table.purpose, table.createdAt),
]);

/** A business's own privacy notice text, one row per version and language. With none, the built-in text is used. */
export const privacyNotices = pgTable("privacy_notices", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  version: varchar("version", { length: 40 }).notNull(),
  language: varchar("language", { length: 10 }).notNull(),
  /** Short plain-language text per purpose, plus the full notice: see PrivacyNoticeText in src/server/privacy/notice.ts. */
  purposes: jsonb("purposes").$type<Record<string, unknown>>().notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  createdAt: createdAt(),
}, (table) => [
  unique("privacy_notices_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("privacy_notices_version_uq").on(table.tenantId, table.version, table.language),
]);

/** A customer's request to download, erase or correct their data. Due 90 days after it is made. */
export const dataRequests = pgTable("data_requests", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  patientId: text("patient_id").notNull(),
  type: dataRequestType("type").notNull(),
  status: dataRequestStatus("status").notNull().default("requested"),
  requestedVia: varchar("requested_via", { length: 20 }).notNull().default("portal"),
  /** What the customer wrote, up to 500 characters. Never copied into the audit log. */
  note: varchar("note", { length: 500 }),
  dueAt: timestamp("due_at", { withTimezone: true, mode: "date" }).notNull().default(sql`now() + interval '90 days'`),
  handledByUserId: text("handled_by_user_id"),
  decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
  /** A fixed word (see decisionReasons in src/server/privacy/rules.ts) so the audit log needs no free text. */
  decisionReason: varchar("decision_reason", { length: 40 }),
  /** What the person who decided added in their own words. Shown to the customer, kept out of the audit log. */
  decisionNote: varchar("decision_note", { length: 500 }),
  /** For erasure: what was removed and what was kept and why, in plain words for the customer. */
  resultSummary: jsonb("result_summary").$type<Record<string, unknown>>(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  /** Set once when the owner was told this request is overdue, so the alert is sent once. */
  overdueAlertedAt: timestamp("overdue_alerted_at", { withTimezone: true, mode: "date" }),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    name: "data_requests_patient_fk",
    columns: [table.tenantId, table.patientId],
    foreignColumns: [patients.tenantId, patients.id],
  }).onDelete("restrict"),
  unique("data_requests_tenant_id_id_uq").on(table.tenantId, table.id),
  // Asking twice while the first is still open returns the first: a double click or a second tap does nothing new.
  uniqueIndex("data_requests_open_uq")
    .on(table.tenantId, table.patientId, table.type)
    .where(sql`${table.status} in ('requested', 'approved', 'processing')`),
  index("data_requests_due_idx").on(table.tenantId, table.status, table.dueAt),
  check("data_requests_version_positive", sql`${table.version} > 0`),
  check(
    "data_requests_reason_valid",
    sql`${table.decisionReason} is null or ${table.decisionReason} in ('verified', 'legal_retention', 'identity_not_confirmed', 'not_this_business', 'duplicate', 'unreasonable', 'other')`,
  ),
  check("data_requests_via_valid", sql`${table.requestedVia} in ('portal', 'staff', 'email')`),
]);

/** One built export per request. The download link's token is stored only as a SHA-256 hash. */
export const dataExports = pgTable("data_exports", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  requestId: text("request_id").notNull(),
  /** The encrypted zip in the private file store. */
  storageKey: text("storage_key").notNull(),
  keyVersion: integer("key_version").notNull().default(0),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
  byteSize: integer("byte_size").notNull(),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({
    name: "data_exports_request_fk",
    columns: [table.tenantId, table.requestId],
    foreignColumns: [dataRequests.tenantId, dataRequests.id],
  }).onDelete("restrict"),
  unique("data_exports_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("data_exports_request_uq").on(table.tenantId, table.requestId),
  uniqueIndex("data_exports_token_uq").on(table.tokenHash),
  check("data_exports_size_positive", sql`${table.byteSize} > 0`),
]);

/** How long a business keeps one kind of data, and what happens then. A missing row means the default for its business type. */
export const retentionPolicies = pgTable("retention_policies", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  dataKind: retentionKind("data_kind").notNull(),
  keepDays: integer("keep_days").notNull(),
  action: retentionAction("action").notNull(),
  updatedByUserId: text("updated_by_user_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("retention_policies_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("retention_policies_kind_uq").on(table.tenantId, table.dataKind),
  check("retention_policies_days_valid", sql`${table.keepDays} between 1 and 36500`),
]);


/**
 * An alert for one staff member: shown under the bell and, if they opted in, sent as a push.
 * The title is short and has no names or contact details ("New booking at 4:30 pm"), so it is safe
 * on a lock screen. `kind` is open text so a new kind needs no migration. `dedupeKey` makes a retry
 * of the same event a no-op.
 */
export const staffNotifications = pgTable("staff_notifications", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  membershipId: text("membership_id").notNull(),
  kind: varchar("kind", { length: 40 }).notNull(),
  title: varchar("title", { length: 140 }).notNull(),
  /** A path inside the app, such as the schedule with the appointment open. Never an outside address. */
  link: varchar("link", { length: 200 }),
  dedupeKey: varchar("dedupe_key", { length: 160 }).notNull(),
  readAt: timestamp("read_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({
    name: "staff_notifications_membership_fk",
    columns: [table.tenantId, table.membershipId],
    foreignColumns: [memberships.tenantId, memberships.id],
  }).onDelete("cascade"),
  unique("staff_notifications_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("staff_notifications_dedupe_uq").on(table.tenantId, table.membershipId, table.dedupeKey),
  index("staff_notifications_inbox_idx").on(table.tenantId, table.membershipId, table.createdAt),
]);

/**
 * A browser's push address for one staff member or one customer. The address is a capability URL
 * and the keys are secrets, so the pair is stored sealed with the business key (src/server/keys/secrets.ts,
 * purpose "push.subscription"); only a hash of the address is kept in the open, to find a repeat.
 */
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  ownerType: varchar("owner_type", { length: 10 }).notNull(),
  membershipId: text("membership_id"),
  patientId: text("patient_id"),
  endpointHash: varchar("endpoint_hash", { length: 64 }).notNull(),
  subscriptionCiphertext: text("subscription_ciphertext").notNull(),
  keyVersion: integer("key_version").notNull(),
  createdAt: createdAt(),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  foreignKey({
    name: "push_subscriptions_membership_fk",
    columns: [table.tenantId, table.membershipId],
    foreignColumns: [memberships.tenantId, memberships.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "push_subscriptions_patient_fk",
    columns: [table.tenantId, table.patientId],
    foreignColumns: [patients.tenantId, patients.id],
  }).onDelete("cascade"),
  unique("push_subscriptions_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("push_subscriptions_endpoint_uq").on(table.tenantId, table.endpointHash),
  check(
    "push_subscriptions_owner_ck",
    sql`(${table.ownerType} = 'staff' and ${table.membershipId} is not null and ${table.patientId} is null)
      or (${table.ownerType} = 'customer' and ${table.patientId} is not null and ${table.membershipId} is null)`,
  ),
  index("push_subscriptions_staff_idx").on(table.tenantId, table.membershipId),
  index("push_subscriptions_patient_idx").on(table.tenantId, table.patientId),
]);

/** Which alerts a staff member gets, per kind. No row means the default: shown in the app and pushed if they opted in. */
export const notificationPreferences = pgTable("notification_preferences", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  membershipId: text("membership_id").notNull(),
  kind: varchar("kind", { length: 40 }).notNull(),
  inApp: boolean("in_app").notNull().default(true),
  push: boolean("push").notNull().default(true),
  /** An email for each alert of this kind (feature 56). Off unless the person turns it on. */
  email: boolean("email").notNull().default(false),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    name: "notification_preferences_membership_fk",
    columns: [table.tenantId, table.membershipId],
    foreignColumns: [memberships.tenantId, memberships.id],
  }).onDelete("cascade"),
  unique("notification_preferences_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("notification_preferences_kind_uq").on(table.tenantId, table.membershipId, table.kind),
]);

/**
 * A staff member's linked calendar account (feature 16). The login (refresh token, or an Apple app-specific
 * password) is stored sealed with the business key (purpose "calendar.credentials"); nothing else about the
 * account's contents is kept here.
 */
export const calendarConnections = pgTable("calendar_connections", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  membershipId: text("membership_id").notNull(),
  provider: varchar("provider", { length: 12 }).notNull(),
  accountEmail: varchar("account_email", { length: 254 }),
  credentialsCiphertext: text("credentials_ciphertext").notNull(),
  keyVersion: integer("key_version").notNull(),
  /** pending (not yet checked by the worker), active, needs_reconnect, or disconnecting (the worker is closing it). */
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  lastErrorCode: varchar("last_error_code", { length: 60 }),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    name: "calendar_connections_membership_fk",
    columns: [table.tenantId, table.membershipId],
    foreignColumns: [memberships.tenantId, memberships.id],
  }).onDelete("cascade"),
  unique("calendar_connections_tenant_id_id_uq").on(table.tenantId, table.id),
  check("calendar_connections_provider_ck", sql`${table.provider} in ('google', 'microsoft', 'apple')`),
  check("calendar_connections_status_ck", sql`${table.status} in ('pending', 'active', 'needs_reconnect', 'disconnecting')`),
  index("calendar_connections_member_idx").on(table.tenantId, table.membershipId),
]);

/** One calendar of a connected account, with the person's choices and the read position for it. */
export const calendarSelections = pgTable("calendar_selections", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  connectionId: text("connection_id").notNull(),
  membershipId: text("membership_id").notNull(),
  calendarId: varchar("calendar_id", { length: 400 }).notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  isPrimary: boolean("is_primary").notNull().default(false),
  canWrite: boolean("can_write").notNull().default(false),
  blocksAvailability: boolean("blocks_availability").notNull().default(false),
  writesHere: boolean("writes_here").notNull().default(false),
  /** The provider's opaque position for "changes since". Not a secret. */
  syncToken: text("sync_token"),
  channelId: varchar("channel_id", { length: 200 }),
  channelResourceId: varchar("channel_resource_id", { length: 400 }),
  channelExpiresAt: timestamp("channel_expires_at", { withTimezone: true, mode: "date" }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "date" }),
  lastSnapshotAt: timestamp("last_snapshot_at", { withTimezone: true, mode: "date" }),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    name: "calendar_selections_connection_fk",
    columns: [table.tenantId, table.connectionId],
    foreignColumns: [calendarConnections.tenantId, calendarConnections.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "calendar_selections_membership_fk",
    columns: [table.tenantId, table.membershipId],
    foreignColumns: [memberships.tenantId, memberships.id],
  }).onDelete("cascade"),
  unique("calendar_selections_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("calendar_selections_calendar_uq").on(table.tenantId, table.connectionId, table.calendarId),
  check("calendar_selections_writes_ck", sql`not ${table.writesHere} or ${table.canWrite}`),
  index("calendar_selections_connection_idx").on(table.tenantId, table.connectionId),
  uniqueIndex("calendar_selections_one_writer_uq").on(table.tenantId, table.membershipId).where(sql`${table.writesHere}`),
]);

/** Busy time read from a staff member's calendars: start, end and the event's id. Never a title or any other text. */
export const externalBusy = pgTable("external_busy", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  membershipId: text("membership_id").notNull(),
  selectionId: text("selection_id").notNull(),
  sourceEventId: varchar("source_event_id", { length: 600 }).notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({
    name: "external_busy_membership_fk",
    columns: [table.tenantId, table.membershipId],
    foreignColumns: [memberships.tenantId, memberships.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "external_busy_selection_fk",
    columns: [table.tenantId, table.selectionId],
    foreignColumns: [calendarSelections.tenantId, calendarSelections.id],
  }).onDelete("cascade"),
  unique("external_busy_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("external_busy_event_uq").on(table.tenantId, table.selectionId, table.sourceEventId),
  check("external_busy_time_order_ck", sql`${table.endsAt} > ${table.startsAt}`),
  index("external_busy_lookup_idx").on(table.tenantId, table.membershipId, table.startsAt, table.endsAt),
]);

/** The outside event Kalendr wrote for an appointment, with the times it pushed so a later change can be told apart. */
export const appointmentEventLinks = pgTable("appointment_event_links", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  appointmentId: text("appointment_id").notNull(),
  selectionId: text("selection_id").notNull(),
  eventId: varchar("event_id", { length: 600 }).notNull(),
  etag: text("etag"),
  fieldsHash: varchar("fields_hash", { length: 64 }).notNull(),
  pushedStartsAt: timestamp("pushed_starts_at", { withTimezone: true, mode: "date" }).notNull(),
  pushedEndsAt: timestamp("pushed_ends_at", { withTimezone: true, mode: "date" }).notNull(),
  /** active, or deleted once Kalendr removed the event itself. */
  status: varchar("status", { length: 12 }).notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    name: "appointment_event_links_appointment_fk",
    columns: [table.tenantId, table.appointmentId],
    foreignColumns: [appointments.tenantId, appointments.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "appointment_event_links_selection_fk",
    columns: [table.tenantId, table.selectionId],
    foreignColumns: [calendarSelections.tenantId, calendarSelections.id],
  }).onDelete("cascade"),
  unique("appointment_event_links_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("appointment_event_links_appointment_uq").on(table.tenantId, table.appointmentId, table.selectionId),
  unique("appointment_event_links_event_uq").on(table.tenantId, table.selectionId, table.eventId),
  check("appointment_event_links_status_ck", sql`${table.status} in ('active', 'deleted')`),
  index("appointment_event_links_selection_idx").on(table.tenantId, table.selectionId),
]);

/** Notifications already taken from a provider, so a repeat is acknowledged and ignored. */
export const calendarWebhookEvents = pgTable("calendar_webhook_events", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 12 }).notNull(),
  eventKey: varchar("event_key", { length: 400 }).notNull(),
  selectionId: text("selection_id"),
  receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  unique("calendar_webhook_events_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("calendar_webhook_events_key_uq").on(table.tenantId, table.provider, table.eventKey),
  index("calendar_webhook_events_received_idx").on(table.receivedAt),
]);

/** The private subscribe-only calendar feed address of a staff member. Only the SHA-256 of the token is kept. */
export const calendarFeedTokens = pgTable("calendar_feed_tokens", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  membershipId: text("membership_id").notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({
    name: "calendar_feed_tokens_membership_fk",
    columns: [table.tenantId, table.membershipId],
    foreignColumns: [memberships.tenantId, memberships.id],
  }).onDelete("cascade"),
  unique("calendar_feed_tokens_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("calendar_feed_tokens_member_uq").on(table.tenantId, table.membershipId),
  unique("calendar_feed_tokens_hash_uq").on(table.tokenHash),
]);

/** "Needs a person": a calendar event Kalendr wrote was moved or deleted outside Kalendr. The appointment is never changed by it. */
export const calendarConflicts = pgTable("calendar_conflicts", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  appointmentId: text("appointment_id").notNull(),
  selectionId: text("selection_id").notNull(),
  membershipId: text("membership_id").notNull(),
  kind: varchar("kind", { length: 10 }).notNull(),
  appointmentStartsAt: timestamp("appointment_starts_at", { withTimezone: true, mode: "date" }).notNull(),
  appointmentEndsAt: timestamp("appointment_ends_at", { withTimezone: true, mode: "date" }).notNull(),
  eventStartsAt: timestamp("event_starts_at", { withTimezone: true, mode: "date" }),
  eventEndsAt: timestamp("event_ends_at", { withTimezone: true, mode: "date" }),
  status: varchar("status", { length: 20 }).notNull().default("open"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
  resolvedBy: text("resolved_by"),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({
    name: "calendar_conflicts_appointment_fk",
    columns: [table.tenantId, table.appointmentId],
    foreignColumns: [appointments.tenantId, appointments.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "calendar_conflicts_selection_fk",
    columns: [table.tenantId, table.selectionId],
    foreignColumns: [calendarSelections.tenantId, calendarSelections.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "calendar_conflicts_membership_fk",
    columns: [table.tenantId, table.membershipId],
    foreignColumns: [memberships.tenantId, memberships.id],
  }).onDelete("cascade"),
  unique("calendar_conflicts_tenant_id_id_uq").on(table.tenantId, table.id),
  check("calendar_conflicts_kind_ck", sql`${table.kind} in ('moved', 'deleted')`),
  check("calendar_conflicts_status_ck", sql`${table.status} in ('open', 'moved_appointment', 'restored_event', 'dismissed', 'obsolete')`),
  uniqueIndex("calendar_conflicts_open_uq").on(table.tenantId, table.appointmentId, table.selectionId).where(sql`${table.status} = 'open'`),
  index("calendar_conflicts_list_idx").on(table.tenantId, table.status, table.createdAt),
]);

/** One row per business: how much of an appointment is written into staff calendars and the private feed. */
export const calendarBusinessSettings = pgTable("calendar_business_settings", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** full, first_name_service or busy_only. */
  eventText: varchar("event_text", { length: 24 }).notNull().default("busy_only"),
  version: integer("version").notNull().default(1),
  updatedAt: updatedAt(),
}, (table) => [
  unique("calendar_business_settings_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("calendar_business_settings_tenant_uq").on(table.tenantId),
  check("calendar_business_settings_text_ck", sql`${table.eventText} in ('full', 'first_name_service', 'busy_only')`),
]);

/**
 * Codes and notices waiting for the worker to send to a customer (feature 8). A sign-in code belongs to no business, so
 * this table has no tenant. Row-level security is on with no policy: the app and worker roles reach it only through the
 * kalendr_queue_code_delivery, kalendr_claim_code_deliveries and kalendr_finish_code_delivery functions. `sealed` holds
 * the destination and code (AES-GCM, purpose patient_delivery) and is cleared once the message is handed to a provider.
 */
export const patientCodeDeliveries = pgTable("patient_code_deliveries", {
  id: id(),
  /** sign_in, step_up or contact_changed. */
  purpose: varchar("purpose", { length: 20 }).notNull(),
  /** auto tries WhatsApp, then text, then email. text skips WhatsApp. */
  via: varchar("via", { length: 8 }).notNull().default("auto"),
  sealed: text("sealed"),
  status: varchar("status", { length: 12 }).notNull().default("pending"),
  attemptCount: smallint("attempt_count").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  lockedBy: varchar("locked_by", { length: 120 }),
  lastErrorCode: varchar("last_error_code", { length: 60 }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: createdAt(),
  finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  index("patient_code_deliveries_due_idx").on(table.status, table.availableAt),
  check("patient_code_deliveries_purpose_ck", sql`${table.purpose} in ('sign_in', 'step_up', 'contact_changed')`),
  check("patient_code_deliveries_via_ck", sql`${table.via} in ('auto', 'text')`),
  check("patient_code_deliveries_status_ck", sql`${table.status} in ('pending', 'processing', 'sent', 'failed')`),
]);

/**
 * A one-time code that lets someone holding a manage link cancel, move or change contact details (feature 8). Tied to
 * the booking, not to the link, because the link changes when the booking is moved. Once the code is entered the row
 * carries a grant (its hash, in a cookie on that device) that lasts a few minutes.
 */
export const bookingStepUps = pgTable("booking_step_ups", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  appointmentId: text("appointment_id").notNull(),
  /** cancel, reschedule or contact. */
  action: varchar("action", { length: 12 }).notNull(),
  codeHash: varchar("code_hash", { length: 64 }).notNull(),
  attemptCount: smallint("attempt_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "date" }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
  grantHash: varchar("grant_hash", { length: 64 }),
  grantExpiresAt: timestamp("grant_expires_at", { withTimezone: true, mode: "date" }),
  usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
}, (table) => [
  unique("booking_step_ups_tenant_id_id_uq").on(table.tenantId, table.id),
  foreignKey({
    name: "booking_step_ups_appointment_fk",
    columns: [table.tenantId, table.appointmentId],
    foreignColumns: [appointments.tenantId, appointments.id],
  }).onDelete("cascade"),
  uniqueIndex("booking_step_ups_grant_uq").on(table.grantHash),
  index("booking_step_ups_appointment_idx").on(table.tenantId, table.appointmentId, table.createdAt),
  check("booking_step_ups_action_ck", sql`${table.action} in ('cancel', 'reschedule', 'contact')`),
]);

/**
 * One offer of a freed time to one person on the waitlist (feature 21). Offers for the same time share a `chainId`: the
 * first person, then the next, up to three. A live offer (`scheduled` or `sent`) keeps its time in `slot_holds` through
 * `holdId`, so the time never shows on the public page between people. The token is 256-bit; only its hash is stored,
 * with a sealed copy the worker reads to build the link (cleared once the message is sent).
 */
export const slotOffers = pgTable("slot_offers", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  entryId: text("entry_id").notNull(),
  serviceId: text("service_id").notNull(),
  locationId: text("location_id").notNull(),
  /** The staff member whose time this is. */
  practitionerId: text("practitioner_id").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
  chainId: text("chain_id").notNull(),
  /** 1 for the first person asked about this time. */
  position: smallint("position").notNull().default(1),
  /** `automatic` from a freed time, or `manual` when staff offered it by hand. */
  origin: varchar("origin", { length: 12 }).notNull().default("automatic"),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  tokenSealed: text("token_sealed"),
  /** scheduled (held, message not sent yet, perhaps waiting for quiet hours to end), sent, accepted, declined, expired or withdrawn. */
  status: varchar("status", { length: 12 }).notNull().default("scheduled"),
  /** The slot hold keeping this time, while the offer is live. */
  holdId: text("hold_id"),
  /** When the message may go out (after quiet hours). */
  sendAt: timestamp("send_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
  /** The end of the time to answer. Set when the offer is made, and again when the message actually goes out. */
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  answeredAt: timestamp("answered_at", { withTimezone: true, mode: "date" }),
  appointmentId: text("appointment_id"),
  /** Short code for why a live offer ended early, such as `staff`, `slot_gone` or `undeliverable`. Never free text. */
  endedReason: varchar("ended_reason", { length: 24 }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("slot_offers_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("slot_offers_token_uq").on(table.tokenHash),
  foreignKey({ name: "slot_offers_entry_fk", columns: [table.tenantId, table.entryId], foreignColumns: [waitlistEntries.tenantId, waitlistEntries.id] }).onDelete("cascade"),
  foreignKey({ name: "slot_offers_service_fk", columns: [table.tenantId, table.serviceId], foreignColumns: [services.tenantId, services.id] }).onDelete("cascade"),
  foreignKey({ name: "slot_offers_location_fk", columns: [table.tenantId, table.locationId], foreignColumns: [locations.tenantId, locations.id] }).onDelete("cascade"),
  foreignKey({ name: "slot_offers_practitioner_fk", columns: [table.tenantId, table.practitionerId], foreignColumns: [practitioners.tenantId, practitioners.id] }).onDelete("cascade"),
  check("slot_offers_time_order_ck", sql`${table.endsAt} > ${table.startsAt}`),
  check("slot_offers_status_ck", sql`${table.status} in ('scheduled', 'sent', 'accepted', 'declined', 'expired', 'withdrawn')`),
  check("slot_offers_origin_ck", sql`${table.origin} in ('automatic', 'manual')`),
  // One live offer per time and person, and one offer per person per chain.
  uniqueIndex("slot_offers_live_slot_uq").on(table.tenantId, table.practitionerId, table.startsAt).where(sql`${table.status} in ('scheduled', 'sent')`),
  uniqueIndex("slot_offers_chain_entry_uq").on(table.tenantId, table.chainId, table.entryId),
  index("slot_offers_chain_idx").on(table.tenantId, table.chainId, table.position),
  index("slot_offers_live_idx").on(table.status, table.expiresAt),
  index("slot_offers_entry_idx").on(table.tenantId, table.entryId, table.status),
]);

/** One row per business: how the waitlist picks the next person to offer a time to (feature 21). */
export const waitlistSettings = pgTable("waitlist_settings", {
  tenantId: text("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }),
  /** `longest_waiting` (default) or `soonest_existing`: people who already have the earliest appointment go first. */
  orderRule: varchar("order_rule", { length: 20 }).notNull().default("longest_waiting"),
  updatedAt: updatedAt(),
}, (table) => [
  check("waitlist_settings_order_ck", sql`${table.orderRule} in ('longest_waiting', 'soonest_existing')`),
]);

/** The switch for automatic offers, per service. No row means on (feature 21). */
export const waitlistServiceSwitches = pgTable("waitlist_service_switches", {
  tenantId: text("tenant_id").notNull(),
  serviceId: text("service_id").notNull(),
  automaticOffers: boolean("automatic_offers").notNull().default(true),
  updatedAt: updatedAt(),
}, (table) => [
  primaryKey({ name: "waitlist_service_switches_pk", columns: [table.tenantId, table.serviceId] }),
  foreignKey({ name: "waitlist_service_switches_service_fk", columns: [table.tenantId, table.serviceId], foreignColumns: [services.tenantId, services.id] }).onDelete("cascade"),
]);

/**
 * A repeating booking (feature 17): the rule and what every visit in it shares. The visits are ordinary
 * appointments that point back here with `series_id` and their place in the rule (`series_index`, starting at 1).
 * The rule is kept both as RFC 5545 text and as the structured form the screen edits. "This and following" ends this
 * series on the day before the change (`until_on`) and starts a new one that points back through `continued_from_id`.
 */
export const appointmentSeries = pgTable("appointment_series", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  patientId: text("patient_id").notNull(),
  serviceId: text("service_id").notNull(),
  practitionerId: text("practitioner_id").notNull(),
  locationId: text("location_id").notNull(),
  /** The RRULE line, for example `RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=8`. Expanded as wall-clock dates in the place's time zone. */
  ruleText: varchar("rule_text", { length: 300 }).notNull(),
  /** The structured rule the screen edits (see src/lib/series-rule.ts). */
  rule: jsonb("rule").$type<Record<string, unknown>>().notNull(),
  /** First day of the rule, as a calendar date in the place's time zone. */
  startsOn: date("starts_on", { mode: "string" }).notNull(),
  /** The clock time every visit starts, such as `10:00`, read in the place's time zone. */
  timeOfDay: varchar("time_of_day", { length: 5 }).notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  /** Exactly one of these ends the series. */
  untilOn: date("until_on", { mode: "string" }),
  occurrenceCount: smallint("occurrence_count"),
  /** `active`, `ended` (finished, or continued in a newer series) or `cancelled`. */
  status: varchar("status", { length: 12 }).notNull().default("active"),
  /** The series this one took over from when staff changed "this and following". */
  continuedFromId: text("continued_from_id"),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("appointment_series_tenant_id_id_uq").on(table.tenantId, table.id),
  foreignKey({ name: "appointment_series_patient_fk", columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id] }).onDelete("restrict"),
  foreignKey({ name: "appointment_series_service_fk", columns: [table.tenantId, table.serviceId], foreignColumns: [services.tenantId, services.id] }).onDelete("restrict"),
  foreignKey({ name: "appointment_series_practitioner_fk", columns: [table.tenantId, table.practitionerId], foreignColumns: [practitioners.tenantId, practitioners.id] }).onDelete("restrict"),
  foreignKey({ name: "appointment_series_location_fk", columns: [table.tenantId, table.locationId], foreignColumns: [locations.tenantId, locations.id] }).onDelete("restrict"),
  foreignKey({ name: "appointment_series_continued_fk", columns: [table.tenantId, table.continuedFromId], foreignColumns: [table.tenantId, table.id] }).onDelete("restrict"),
  check("appointment_series_status_ck", sql`${table.status} in ('active', 'ended', 'cancelled')`),
  check("appointment_series_end_ck", sql`(${table.untilOn} is null) <> (${table.occurrenceCount} is null)`),
  check("appointment_series_count_ck", sql`${table.occurrenceCount} is null or ${table.occurrenceCount} between 1 and 52`),
  check("appointment_series_duration_ck", sql`${table.durationMinutes} > 0`),
  check("appointment_series_version_ck", sql`${table.version} > 0`),
  index("appointment_series_patient_idx").on(table.tenantId, table.patientId, table.status),
]);

/** Quick reasons staff pick when they cancel ("Doctor unwell", "Clinic closed"). The label is copied onto the booking (feature 42). */
export const cancelNotePresets = pgTable("cancel_note_presets", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  label: varchar("label", { length: 80 }).notNull(),
  sortOrder: smallint("sort_order").notNull().default(0),
  createdAt: createdAt(),
}, (table) => [
  unique("cancel_note_presets_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("cancel_note_presets_label_uq").on(table.tenantId, table.label),
  index("cancel_note_presets_tenant_idx").on(table.tenantId, table.sortOrder),
]);

/** A named filter set for the bookings list, private to its owner or shared with the team (feature 43). */
export const savedViews = pgTable("saved_views", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  ownerMembershipId: text("owner_membership_id").notNull(),
  name: varchar("name", { length: 80 }).notNull(),
  /** Where it is used. Only `bookings` today. */
  page: varchar("page", { length: 16 }).notNull().default("bookings"),
  shared: boolean("shared").notNull().default(false),
  /** The filter object, validated on the way in and on the way out. */
  filters: jsonb("filters").$type<Record<string, unknown>>().notNull().default({}),
  sort: varchar("sort", { length: 8 }).notNull().default("asc"),
  /** Column keys in the order shown. Empty means the default columns. */
  columns: text("columns").array().notNull().default(sql`ARRAY[]::text[]`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("saved_views_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("saved_views_owner_name_uq").on(table.tenantId, table.ownerMembershipId, table.page, table.name),
  foreignKey({ name: "saved_views_owner_fk", columns: [table.tenantId, table.ownerMembershipId], foreignColumns: [memberships.tenantId, memberships.id] }).onDelete("cascade"),
  check("saved_views_page_valid", sql`${table.page} in ('bookings')`),
  check("saved_views_sort_valid", sql`${table.sort} in ('asc', 'desc')`),
  index("saved_views_lookup_idx").on(table.tenantId, table.page, table.shared),
]);

/** The business did not turn up: the person who should have seen the customer (feature 43). Reports read it. */
export const appointmentHostNoShows = pgTable("appointment_host_no_shows", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  appointmentId: text("appointment_id").notNull(),
  practitionerId: text("practitioner_id").notNull(),
  markedByUserId: text("marked_by_user_id"),
  markedAt: timestamp("marked_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  unique("appointment_host_no_shows_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("appointment_host_no_shows_appointment_uq").on(table.tenantId, table.appointmentId),
  foreignKey({ name: "host_no_shows_appointment_fk", columns: [table.tenantId, table.appointmentId], foreignColumns: [appointments.tenantId, appointments.id] }).onDelete("cascade"),
  foreignKey({ name: "host_no_shows_practitioner_fk", columns: [table.tenantId, table.practitionerId], foreignColumns: [practitioners.tenantId, practitioners.id] }).onDelete("cascade"),
  index("host_no_shows_person_idx").on(table.tenantId, table.practitionerId, table.markedAt),
]);

/**
 * Public API keys (feature 34). The key itself is shown once and never stored: only its SHA-256 hash is,
 * with a short visible prefix so a leaked key can be traced back. Looking a key up crosses businesses, so
 * that one read goes through kalendr_resolve_api_key (ids only); everything after runs in tenant scope.
 */
export const apiKeys = pgTable("api_keys", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 80 }).notNull(),
  /** `kal_live_` or `kal_test_` plus the first characters of the secret part. Safe to show. */
  prefix: varchar("prefix", { length: 24 }).notNull(),
  keyHash: varchar("key_hash", { length: 64 }).notNull(),
  /** Names such as appointments:read. Checked on every request. */
  scopes: text("scopes").array().notNull(),
  /** Test keys are read-only: they let a developer try the API without changing a booking. */
  mode: varchar("mode", { length: 8 }).notNull().default("live"),
  createdByUserId: text("created_by_user_id"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
}, (table) => [
  unique("api_keys_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("api_keys_hash_uq").on(table.keyHash),
  check("api_keys_mode_ck", sql`${table.mode} in ('live', 'test')`),
  check("api_keys_scopes_ck", sql`cardinality(${table.scopes}) between 1 and 20`),
  index("api_keys_list_idx").on(table.tenantId, table.createdAt),
]);

/** An address a business wants events sent to. The signing secret is sealed with the business's data key. */
export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  url: varchar("url", { length: 2000 }).notNull(),
  description: varchar("description", { length: 120 }),
  secretCiphertext: text("secret_ciphertext").notNull(),
  keyVersion: integer("key_version").notNull(),
  /** Public event names, such as appointment.created. */
  events: text("events").array().notNull(),
  /** active, or disabled (by the owner, or by the worker after repeated failure; see disabledReason). */
  status: varchar("status", { length: 12 }).notNull().default("active"),
  consecutiveFailures: smallint("consecutive_failures").notNull().default(0),
  disabledAt: timestamp("disabled_at", { withTimezone: true, mode: "date" }),
  /** owner, or repeated_failure. A fixed code, never text from the receiver. */
  disabledReason: varchar("disabled_reason", { length: 24 }),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("webhook_endpoints_tenant_id_id_uq").on(table.tenantId, table.id),
  check("webhook_endpoints_status_ck", sql`${table.status} in ('active', 'disabled')`),
  check("webhook_endpoints_events_ck", sql`cardinality(${table.events}) between 1 and 20`),
  index("webhook_endpoints_list_idx").on(table.tenantId, table.createdAt),
]);

/**
 * One row per event per endpoint, updated as attempts happen. `payload` is the exact body that is sent
 * (ids and changed fields only), kept so a resend sends the same thing.
 */
export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  endpointId: text("endpoint_id").notNull(),
  /** The event's id, shown to the receiver as X-Kalendr-Event-Id so it can drop repeats. */
  eventId: varchar("event_id", { length: 80 }).notNull(),
  eventType: varchar("event_type", { length: 60 }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  isTest: boolean("is_test").notNull().default(false),
  /** pending, succeeded, retrying (next try is scheduled) or gave_up. */
  status: varchar("status", { length: 12 }).notNull().default("pending"),
  attempt: smallint("attempt").notNull().default(0),
  statusCode: smallint("status_code"),
  durationMs: integer("duration_ms"),
  /** A fixed code such as timeout, blocked_address or http_status. Never the receiver's reply. */
  errorCode: varchar("error_code", { length: 40 }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true, mode: "date" }),
  resendOfId: text("resend_of_id"),
  createdAt: createdAt(),
}, (table) => [
  unique("webhook_deliveries_tenant_id_id_uq").on(table.tenantId, table.id),
  foreignKey({
    name: "webhook_deliveries_endpoint_fk",
    columns: [table.tenantId, table.endpointId],
    foreignColumns: [webhookEndpoints.tenantId, webhookEndpoints.id],
  }).onDelete("cascade"),
  uniqueIndex("webhook_deliveries_event_uq").on(table.tenantId, table.endpointId, table.eventId).where(sql`${table.resendOfId} is null`),
  check("webhook_deliveries_status_ck", sql`${table.status} in ('pending', 'succeeded', 'retrying', 'gave_up')`),
  index("webhook_deliveries_log_idx").on(table.tenantId, table.endpointId, table.createdAt),
]);

/**
 * A bulk import of customers, services or future appointments (feature 12). The uploaded file lives
 * encrypted in the file store; this row holds the choices made about it and the running totals. No
 * cell value from the file is ever stored here: rows are re-read from the file when they are needed.
 */
export const importJobs = pgTable("import_jobs", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** customers, services or appointments. */
  kind: varchar("kind", { length: 16 }).notNull(),
  /** csv or xlsx. */
  fileFormat: varchar("file_format", { length: 8 }).notNull(),
  /** Where the encrypted file is, until it is purged (when the undo window closes). Null once purged. */
  fileKey: varchar("file_key", { length: 300 }),
  keyVersion: integer("key_version").notNull().default(0),
  fileBytes: integer("file_bytes").notNull(),
  rowCount: integer("row_count").notNull().default(0),
  /** Which column feeds which field, and the choices (date format, duplicate rule, consent tick). Column positions and field names only. */
  mapping: jsonb("mapping").$type<Record<string, unknown>>().notNull().default({}),
  options: jsonb("options").$type<Record<string, unknown>>().notNull().default({}),
  /** uploaded, mapped, checking, checked, queued, running, done, failed, undoing, undone. */
  status: varchar("status", { length: 12 }).notNull().default("uploaded"),
  readyCount: integer("ready_count").notNull().default(0),
  updateCount: integer("update_count").notNull().default(0),
  skipCount: integer("skip_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  createdCount: integer("created_count").notNull().default(0),
  updatedCount: integer("updated_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  /** A fixed reason code when the whole job failed, never a message from the file. */
  failureCode: varchar("failure_code", { length: 40 }),
  startedByUserId: text("started_by_user_id"),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
  finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
  /** The last moment an undo is allowed: seven days after the import finished. */
  undoUntil: timestamp("undo_until", { withTimezone: true, mode: "date" }),
  undoneAt: timestamp("undone_at", { withTimezone: true, mode: "date" }),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("import_jobs_tenant_id_id_uq").on(table.tenantId, table.id),
  check("import_jobs_kind_ck", sql`${table.kind} in ('customers', 'services', 'appointments')`),
  check("import_jobs_format_ck", sql`${table.fileFormat} in ('csv', 'xlsx')`),
  check("import_jobs_status_ck", sql`${table.status} in ('uploaded', 'mapped', 'checking', 'checked', 'queued', 'running', 'done', 'failed', 'undoing', 'undone')`),
  index("import_jobs_list_idx").on(table.tenantId, table.createdAt),
]);

/**
 * One row per file row. It keeps the outcome only: a status, a fixed error code with the name of the field at fault, and
 * the id of the record it made. The person's values stay in the encrypted file.
 */
export const importRows = pgTable("import_rows", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  jobId: text("job_id").notNull(),
  /** 1 is the first data row (the header is not counted). */
  rowNumber: integer("row_number").notNull(),
  /** Check: ready, will_update, will_skip, error. Import: created, updated, skipped, failed, undone. */
  status: varchar("status", { length: 12 }).notNull(),
  errorCode: varchar("error_code", { length: 40 }),
  errorField: varchar("error_field", { length: 40 }),
  /** The customer, service or appointment this row made or changed. */
  entityId: text("entity_id"),
  updatedAt: updatedAt(),
}, (table) => [
  unique("import_rows_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("import_rows_job_row_uq").on(table.tenantId, table.jobId, table.rowNumber),
  foreignKey({
    name: "import_rows_job_fk",
    columns: [table.tenantId, table.jobId],
    foreignColumns: [importJobs.tenantId, importJobs.id],
  }).onDelete("cascade"),
  check("import_rows_status_ck", sql`${table.status} in ('ready', 'will_update', 'will_skip', 'error', 'created', 'updated', 'skipped', 'failed', 'undone')`),
  index("import_rows_status_idx").on(table.tenantId, table.jobId, table.status),
]);

/**
 * Kalendr's own operators (feature 15). Not tenant data: no tenant_id. The runtime role cannot read or
 * write this table (forced row-level security, no policy); only the named `admin_*` definer functions
 * touch it, and each of those checks the caller's role first.
 */
export const platformAdmins = pgTable("platform_admins", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  /** support: read and message fixes. billing: plans and trials. super: everything, including write access when viewing as a business. */
  role: varchar("role", { length: 12 }).notNull(),
  addedBy: text("added_by"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("platform_admins_user_uq").on(table.userId),
  check("platform_admins_role_ck", sql`${table.role} in ('support', 'billing', 'super')`),
]);

/** One "View as this business" session. Only the SHA-256 of its token is stored. */
export const impersonationSessions = pgTable("impersonation_sessions", {
  id: id(),
  adminUserId: text("admin_user_id").notNull(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** Why the operator is looking, in their own words. Shown to the business owner. */
  reason: varchar("reason", { length: 300 }).notNull(),
  writeAccess: boolean("write_access").notNull().default(false),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  startedAt: createdAt(),
  endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  uniqueIndex("impersonation_sessions_token_uq").on(table.tokenHash),
  index("impersonation_sessions_tenant_idx").on(table.tenantId, table.startedAt),
  check("impersonation_sessions_window_ck", sql`${table.endsAt} > ${table.startedAt} and ${table.endsAt} <= ${table.startedAt} + interval '30 minutes'`),
]);

/** Everything an operator does. Append-only (a trigger refuses update and delete). No customer data and no free text beyond the reason. */
export const platformAuditEvents = pgTable("platform_audit_events", {
  id: id(),
  adminUserId: text("admin_user_id").notNull(),
  tenantId: text("tenant_id"),
  action: varchar("action", { length: 120 }).notNull(),
  reason: varchar("reason", { length: 300 }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  index("platform_audit_events_tenant_idx").on(table.tenantId, table.occurredAt),
  index("platform_audit_events_time_idx").on(table.occurredAt),
]);

/**
 * Gradual release of a feature across businesses. `mode` is off, listed (only `tenantIds`), percent
 * (a stable share of businesses chosen by hashing the business id with the key) or all. A business's
 * own `tenants.features` still applies on top. Readable by the runtime role; written only by `admin_set_feature_rollout`.
 */
export const featureRollouts = pgTable("feature_rollouts", {
  featureKey: varchar("feature_key", { length: 60 }).primaryKey(),
  mode: varchar("mode", { length: 8 }).notNull().default("off"),
  percent: smallint("percent").notNull().default(0),
  tenantIds: text("tenant_ids").array().notNull().default(sql`'{}'::text[]`),
  updatedAt: updatedAt(),
}, (table) => [
  check("feature_rollouts_mode_ck", sql`${table.mode} in ('off', 'listed', 'percent', 'all')`),
  check("feature_rollouts_percent_ck", sql`${table.percent} between 0 and 100`),
]);

/**
 * Plans (feature 14). Not tenant data. Prices are integers in the smallest unit; `limits` is checked on read by
 * `parsePlanLimits` in src/lib/entitlements.ts. Provider ids are filled by the plan sync script once the owner's
 * Razorpay and Stripe accounts exist.
 */
export const plans = pgTable("plans", {
  key: varchar("key", { length: 20 }).primaryKey(),
  name: varchar("name", { length: 60 }).notNull(),
  sortOrder: smallint("sort_order").notNull(),
  priceInrMinor: integer("price_inr_minor").notNull().default(0),
  priceUsdMinor: integer("price_usd_minor").notNull().default(0),
  limits: jsonb("limits").$type<Record<string, unknown>>().notNull(),
  razorpayPlanId: varchar("razorpay_plan_id", { length: 80 }),
  stripePriceId: varchar("stripe_price_id", { length: 80 }),
  isPublic: boolean("is_public").notNull().default(true),
});

/** One row per business: where it is in its subscription. Edited only by the webhook worker and the owner's own actions. */
export const tenantSubscriptions = pgTable("tenant_subscriptions", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  planKey: varchar("plan_key", { length: 20 }).notNull().references(() => plans.key),
  /** trialing, active, past_due, paused, cancelled or free. What the business can actually use comes from `effectivePlanKey`. */
  status: varchar("status", { length: 12 }).notNull().default("trialing"),
  provider: varchar("provider", { length: 10 }),
  providerCustomerId: varchar("provider_customer_id", { length: 120 }),
  providerSubscriptionId: varchar("provider_subscription_id", { length: 120 }),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true, mode: "date" }),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true, mode: "date" }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true, mode: "date" }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  /** A downgrade chosen mid-period; applied when the period ends. */
  pendingPlanKey: varchar("pending_plan_key", { length: 20 }).references(() => plans.key),
  /** When the first failed renewal happened. Full service continues for 7 days after this. */
  pastDueSince: timestamp("past_due_since", { withTimezone: true, mode: "date" }),
  /** stop_marketing or bill_overage: what happens to marketing messages past the included amount. */
  overageMode: varchar("overage_mode", { length: 16 }).notNull().default("stop_marketing"),
  /** The business's own GSTIN, printed on Kalendr's invoices to it when given. */
  billingGstin: varchar("billing_gstin", { length: 15 }),
  /** Alerts already sent, such as `2026-11:whatsapp:80`, so each goes out once. */
  usageAlertsSent: text("usage_alerts_sent").array().notNull().default(sql`'{}'::text[]`),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("tenant_subscriptions_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("tenant_subscriptions_tenant_uq").on(table.tenantId),
  uniqueIndex("tenant_subscriptions_provider_uq").on(table.provider, table.providerSubscriptionId).where(sql`${table.providerSubscriptionId} is not null`),
  check("tenant_subscriptions_status_ck", sql`${table.status} in ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'free')`),
  check("tenant_subscriptions_provider_ck", sql`${table.provider} is null or ${table.provider} in ('razorpay', 'stripe')`),
  check("tenant_subscriptions_overage_ck", sql`${table.overageMode} in ('stop_marketing', 'bill_overage')`),
]);

/** Provider webhook events for subscriptions. Insert-only; the unique key makes a repeat delivery a no-op. The payload keeps ids and amounts, never card or UPI details. */
export const billingEvents = pgTable("billing_events", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 10 }).notNull(),
  providerEventId: varchar("provider_event_id", { length: 200 }).notNull(),
  type: varchar("type", { length: 100 }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  /** Set by the worker when it has applied the event. The only column that may change. */
  processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
  outcome: varchar("outcome", { length: 40 }),
}, (table) => [
  unique("billing_events_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("billing_events_provider_event_uq").on(table.provider, table.providerEventId),
  check("billing_events_provider_ck", sql`${table.provider} in ('razorpay', 'stripe')`),
]);

/** What a business used this month, by metric (`message:whatsapp:utility`, `message:sms`, `message:email`, `bookings`). A counter, not money. */
export const usageCounters = pgTable("usage_counters", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** First day of the month, in UTC. */
  period: date("period", { mode: "string" }).notNull(),
  metric: varchar("metric", { length: 60 }).notNull(),
  count: integer("count").notNull().default(0),
  updatedAt: updatedAt(),
}, (table) => [
  unique("usage_counters_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("usage_counters_key_uq").on(table.tenantId, table.period, table.metric),
  check("usage_counters_count_ck", sql`${table.count} >= 0`),
]);

/**
 * Kalendr's own invoices to businesses. Money rows: a trigger refuses any update or delete, and a correction is a new
 * row. Numbers come from `kalendr_next_platform_invoice_number()` inside the same transaction, so they have no gaps.
 */
export const platformInvoices = pgTable("platform_invoices", {
  id: id(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "restrict" }),
  invoiceNumber: varchar("invoice_number", { length: 30 }).notNull(),
  sequence: integer("sequence").notNull(),
  provider: varchar("provider", { length: 10 }).notNull(),
  providerPaymentId: varchar("provider_payment_id", { length: 120 }).notNull(),
  planKey: varchar("plan_key", { length: 20 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  /** Before tax. */
  amountMinor: integer("amount_minor").notNull(),
  gstRateBps: smallint("gst_rate_bps").notNull().default(0),
  gstMinor: integer("gst_minor").notNull().default(0),
  totalMinor: integer("total_minor").notNull(),
  kalendrGstin: varchar("kalendr_gstin", { length: 15 }),
  buyerGstin: varchar("buyer_gstin", { length: 15 }),
  periodStart: timestamp("period_start", { withTimezone: true, mode: "date" }),
  periodEnd: timestamp("period_end", { withTimezone: true, mode: "date" }),
  issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  unique("platform_invoices_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("platform_invoices_number_uq").on(table.invoiceNumber),
  uniqueIndex("platform_invoices_sequence_uq").on(table.sequence),
  uniqueIndex("platform_invoices_payment_uq").on(table.provider, table.providerPaymentId),
  index("platform_invoices_tenant_idx").on(table.tenantId, table.issuedAt),
  check("platform_invoices_total_ck", sql`${table.totalMinor} = ${table.amountMinor} + ${table.gstMinor} and ${table.amountMinor} >= 0 and ${table.gstMinor} >= 0`),
]);

/**
 * Online payments (feature 23). Each business connects its own account, so customer money goes
 * straight to the business and Kalendr never holds it. Keys are sealed with the business's data key
 * (src/server/keys/secrets.ts); `public_id` is the unguessable part of the webhook address.
 * One account per business. `fake` exists only outside production, for tests and local runs.
 */
export const tenantPaymentAccounts = pgTable("tenant_payment_accounts", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 12 }).notNull(),
  /** `test` accounts take no real money and their payments are kept out of reports. */
  mode: varchar("mode", { length: 4 }).notNull().default("test"),
  status: varchar("status", { length: 10 }).notNull().default("active"),
  /** The public key id (Razorpay key id) or the connected account id (Stripe). Not a secret. */
  keyId: varchar("key_id", { length: 80 }).notNull(),
  secretCiphertext: text("secret_ciphertext"),
  webhookSecretCiphertext: text("webhook_secret_ciphertext"),
  keyVersion: integer("key_version").notNull().default(0),
  publicId: varchar("public_id", { length: 48 }).notNull(),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("tenant_payment_accounts_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("tenant_payment_accounts_tenant_uq").on(table.tenantId),
  uniqueIndex("tenant_payment_accounts_public_uq").on(table.publicId),
  check("tenant_payment_accounts_provider_ck", sql`${table.provider} in ('razorpay', 'stripe', 'fake')`),
  check("tenant_payment_accounts_mode_ck", sql`${table.mode} in ('test', 'live')`),
  check("tenant_payment_accounts_status_ck", sql`${table.status} in ('active', 'disabled')`),
]);

/** The three plain settings every customer is shown before they pay. One row per business. */
export const tenantPaymentPolicies = pgTable("tenant_payment_policies", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  /** Cancelling at least this long before the visit refunds everything paid. */
  freeCancelHours: integer("free_cancel_hours").notNull().default(24),
  /** After that window: `no_refund`, or `keep_deposit` (refund what was paid beyond the deposit). */
  afterWindowRule: varchar("after_window_rule", { length: 12 }).notNull().default("no_refund"),
  /** A no-show forfeits `deposit` or `everything` paid. Nothing more is ever charged. */
  noShowRule: varchar("no_show_rule", { length: 12 }).notNull().default("deposit"),
  version: integer("version").notNull().default(1),
  updatedAt: updatedAt(),
}, (table) => [
  unique("tenant_payment_policies_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("tenant_payment_policies_tenant_uq").on(table.tenantId),
  check("tenant_payment_policies_hours_ck", sql`${table.freeCancelHours} between 0 and 8760`),
  check("tenant_payment_policies_after_ck", sql`${table.afterWindowRule} in ('no_refund', 'keep_deposit')`),
  check("tenant_payment_policies_noshow_ck", sql`${table.noShowRule} in ('deposit', 'everything')`),
]);

/**
 * One checkout asked of the provider. This is the only mutable part of an online payment: it moves
 * `created` to `paid`, `failed` or `expired`. The money itself is written to `payments` once, when
 * the provider's webhook says it was captured. The amount is worked out on the server from the service.
 */
export const paymentOrders = pgTable("payment_orders", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  appointmentId: text("appointment_id").notNull(),
  accountId: text("account_id").notNull(),
  provider: varchar("provider", { length: 12 }).notNull(),
  mode: varchar("mode", { length: 4 }).notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  status: varchar("status", { length: 10 }).notNull().default("created"),
  providerOrderId: varchar("provider_order_id", { length: 80 }),
  /** A hosted checkout address when the provider gives one (Stripe, payment links). */
  checkoutUrl: text("checkout_url"),
  /** A staff-sent pay link: only its hash is kept. Null for orders made in the booking flow. */
  linkTokenHash: varchar("link_token_hash", { length: 64 }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({ name: "payment_orders_appointment_fk", columns: [table.tenantId, table.appointmentId], foreignColumns: [appointments.tenantId, appointments.id] }).onDelete("restrict"),
  foreignKey({ name: "payment_orders_account_fk", columns: [table.tenantId, table.accountId], foreignColumns: [tenantPaymentAccounts.tenantId, tenantPaymentAccounts.id] }).onDelete("restrict"),
  unique("payment_orders_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("payment_orders_provider_order_uq").on(table.provider, table.providerOrderId).where(sql`${table.providerOrderId} is not null`),
  uniqueIndex("payment_orders_open_uq").on(table.tenantId, table.appointmentId).where(sql`${table.status} = 'created'`),
  uniqueIndex("payment_orders_link_uq").on(table.linkTokenHash).where(sql`${table.linkTokenHash} is not null`),
  check("payment_orders_amount_positive", sql`${table.amountMinor} > 0`),
  check("payment_orders_status_ck", sql`${table.status} in ('created', 'paid', 'failed', 'expired')`),
  index("payment_orders_appointment_idx").on(table.tenantId, table.appointmentId),
]);

/** A refund asked for and not yet paid out. When the provider confirms, a `payment_refunds` row is written and this is marked done. */
export const refundRequests = pgTable("refund_requests", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  paymentId: text("payment_id").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  /** Free text from staff stays here, never in audit metadata. */
  reason: varchar("reason", { length: 200 }).notNull(),
  /** `policy` (cancel), `staff`, `late_payment` (paid after the time was taken) or `reschedule`. */
  source: varchar("source", { length: 14 }).notNull(),
  status: varchar("status", { length: 10 }).notNull().default("pending"),
  providerRefundId: varchar("provider_refund_id", { length: 80 }),
  failureCode: varchar("failure_code", { length: 60 }),
  requestedByUserId: text("requested_by_user_id"),
  /** Makes asking twice for the same thing a no-op. */
  dedupeKey: varchar("dedupe_key", { length: 160 }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({ name: "refund_requests_payment_fk", columns: [table.tenantId, table.paymentId], foreignColumns: [payments.tenantId, payments.id] }).onDelete("restrict"),
  unique("refund_requests_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("refund_requests_dedupe_uq").on(table.tenantId, table.dedupeKey),
  check("refund_requests_amount_positive", sql`${table.amountMinor} > 0`),
  check("refund_requests_source_ck", sql`${table.source} in ('policy', 'staff', 'late_payment', 'reschedule')`),
  check("refund_requests_status_ck", sql`${table.status} in ('pending', 'done', 'failed')`),
  index("refund_requests_payment_idx").on(table.tenantId, table.paymentId),
  index("refund_requests_open_idx").on(table.status, table.createdAt),
]);

/**
 * Every webhook the providers sent, one row per provider event id. The payload is cut down to ids,
 * amounts and statuses before it is stored: provider payloads carry the payer's email and phone.
 */
export const paymentEvents = pgTable("payment_events", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  accountId: text("account_id").notNull(),
  provider: varchar("provider", { length: 12 }).notNull(),
  providerEventId: varchar("provider_event_id", { length: 120 }).notNull(),
  type: varchar("type", { length: 80 }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({ name: "payment_events_account_fk", columns: [table.tenantId, table.accountId], foreignColumns: [tenantPaymentAccounts.tenantId, tenantPaymentAccounts.id] }).onDelete("cascade"),
  unique("payment_events_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("payment_events_event_uq").on(table.accountId, table.providerEventId),
]);

/** What the nightly check found that the ledger and the provider disagree on. The owner clears these. */
export const paymentMismatches = pgTable("payment_mismatches", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  accountId: text("account_id").notNull(),
  day: date("day", { mode: "string" }).notNull(),
  /** `missing_here` (paid at the provider, not in Kalendr), `missing_at_provider`, or `amount_differs`. */
  kind: varchar("kind", { length: 20 }).notNull(),
  providerPaymentId: varchar("provider_payment_id", { length: 80 }).notNull(),
  providerAmountMinor: integer("provider_amount_minor"),
  ledgerAmountMinor: integer("ledger_amount_minor"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
  resolvedByUserId: text("resolved_by_user_id"),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({ name: "payment_mismatches_account_fk", columns: [table.tenantId, table.accountId], foreignColumns: [tenantPaymentAccounts.tenantId, tenantPaymentAccounts.id] }).onDelete("cascade"),
  unique("payment_mismatches_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("payment_mismatches_uq").on(table.accountId, table.providerPaymentId, table.kind),
  check("payment_mismatches_kind_ck", sql`${table.kind} in ('missing_here', 'missing_at_provider', 'amount_differs')`),
]);

/**
 * How a business is registered for GST (feature 24). One row per business. Nothing here is decided for the owner:
 * the treatment shown is a default for the business type until `confirmed_at` is set by the owner.
 */
export const taxSettings = pgTable("tax_settings", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  /** Registered for GST. Not registered: every document is a receipt with no tax. */
  registered: boolean("registered").notNull().default(false),
  gstin: varchar("gstin", { length: 15 }),
  /** The name and address printed as the seller. Copied onto each invoice when it is issued. */
  legalName: varchar("legal_name", { length: 200 }),
  address: varchar("address", { length: 400 }),
  /** The two-digit GST state code the business supplies from. */
  stateCode: varchar("state_code", { length: 2 }),
  /** Prices are what the customer pays (tax inside) rather than before tax. */
  pricesIncludeTax: boolean("prices_include_tax").notNull().default(true),
  /** What a service without its own rule gets. */
  defaultTreatment: varchar("default_treatment", { length: 8 }).notNull().default("exempt"),
  defaultRateBps: smallint("default_rate_bps").notNull().default(0),
  defaultSacCode: varchar("default_sac_code", { length: 8 }),
  /** Set when the owner confirmed the treatment (with their accountant). Empty until then. */
  confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "date" }),
  confirmedByUserId: text("confirmed_by_user_id"),
  version: integer("version").notNull().default(1),
  updatedAt: updatedAt(),
}, (table) => [
  unique("tax_settings_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("tax_settings_tenant_uq").on(table.tenantId),
  check("tax_settings_treatment_ck", sql`${table.defaultTreatment} in ('taxable', 'exempt', 'nil')`),
  check("tax_settings_rate_ck", sql`${table.defaultRateBps} between 0 and 4000`),
  check("tax_settings_registered_ck", sql`not ${table.registered} or (${table.gstin} is not null and ${table.stateCode} is not null and ${table.legalName} is not null)`),
]);

/** A service's own tax treatment, set by the owner. Without a row the business default applies. */
export const serviceTaxRules = pgTable("service_tax_rules", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  serviceId: text("service_id").notNull(),
  treatment: varchar("treatment", { length: 8 }).notNull(),
  rateBps: smallint("rate_bps").notNull().default(0),
  sacCode: varchar("sac_code", { length: 8 }),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({ name: "service_tax_rules_service_fk", columns: [table.tenantId, table.serviceId], foreignColumns: [services.tenantId, services.id] }).onDelete("cascade"),
  unique("service_tax_rules_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("service_tax_rules_service_uq").on(table.tenantId, table.serviceId),
  check("service_tax_rules_treatment_ck", sql`${table.treatment} in ('taxable', 'exempt', 'nil')`),
  check("service_tax_rules_rate_ck", sql`${table.rateBps} between 0 and 4000`),
]);

/** The last number given out per business, financial year and series. The row is locked inside the issuing transaction. */
export const invoiceCounters = pgTable("invoice_counters", {
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
  financialYear: varchar("financial_year", { length: 7 }).notNull(),
  series: varchar("series", { length: 4 }).notNull(),
  lastNumber: integer("last_number").notNull().default(0),
  updatedAt: updatedAt(),
}, (table) => [
  primaryKey({ name: "invoice_counters_pk", columns: [table.tenantId, table.financialYear, table.series] }),
  check("invoice_counters_number_ck", sql`${table.lastNumber} >= 0`),
]);

/**
 * A business's invoice to its own customer. Only issued invoices exist: the screen's draft is a preview, so a number
 * is never given out for something that was not issued. A trigger refuses any update or delete; a mistake is fixed with a
 * credit note and a new invoice. Whether it is paid is worked out from the payments, never stored.
 */
export const invoices = pgTable("invoices", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
  financialYear: varchar("financial_year", { length: 7 }).notNull(),
  series: varchar("series", { length: 4 }).notNull().default("INV"),
  sequence: integer("sequence").notNull(),
  number: varchar("number", { length: 24 }).notNull(),
  patientId: text("patient_id").notNull(),
  /** The visit this bills. Empty for a sale such as a package. */
  appointmentId: text("appointment_id"),
  locationId: text("location_id").notNull(),
  /** `visit`, `package` or `membership`. */
  source: varchar("source", { length: 12 }).notNull().default("visit"),
  /** `tax_invoice`, `bill_of_supply` or `receipt`. */
  kind: varchar("kind", { length: 14 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  pricesIncludeTax: boolean("prices_include_tax").notNull(),
  taxableMinor: integer("taxable_minor").notNull(),
  cgstMinor: integer("cgst_minor").notNull().default(0),
  sgstMinor: integer("sgst_minor").notNull().default(0),
  igstMinor: integer("igst_minor").notNull().default(0),
  totalMinor: integer("total_minor").notNull(),
  /** `intra` (CGST and SGST), `inter` (IGST) or `none` (no tax charged). */
  supply: varchar("supply", { length: 5 }).notNull(),
  placeOfSupplyState: varchar("place_of_supply_state", { length: 2 }),
  sellerGstin: varchar("seller_gstin", { length: 15 }),
  sellerLegalName: varchar("seller_legal_name", { length: 200 }).notNull(),
  sellerAddress: varchar("seller_address", { length: 400 }),
  sellerStateCode: varchar("seller_state_code", { length: 2 }),
  buyerName: varchar("buyer_name", { length: 200 }).notNull(),
  buyerGstin: varchar("buyer_gstin", { length: 15 }),
  buyerStateCode: varchar("buyer_state_code", { length: 2 }),
  exemptionNote: varchar("exemption_note", { length: 200 }),
  issuedByUserId: text("issued_by_user_id"),
  issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ name: "invoices_patient_fk", columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id] }).onDelete("restrict"),
  foreignKey({ name: "invoices_appointment_fk", columns: [table.tenantId, table.appointmentId], foreignColumns: [appointments.tenantId, appointments.id] }).onDelete("restrict"),
  foreignKey({ name: "invoices_location_fk", columns: [table.tenantId, table.locationId], foreignColumns: [locations.tenantId, locations.id] }).onDelete("restrict"),
  unique("invoices_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("invoices_number_uq").on(table.tenantId, table.number),
  uniqueIndex("invoices_sequence_uq").on(table.tenantId, table.financialYear, table.series, table.sequence),
  index("invoices_patient_idx").on(table.tenantId, table.patientId, table.issuedAt),
  index("invoices_appointment_idx").on(table.tenantId, table.appointmentId),
  index("invoices_issued_idx").on(table.tenantId, table.issuedAt),
  check("invoices_source_ck", sql`${table.source} in ('visit', 'package', 'membership')`),
  check("invoices_kind_ck", sql`${table.kind} in ('tax_invoice', 'bill_of_supply', 'receipt')`),
  check("invoices_supply_ck", sql`${table.supply} in ('intra', 'inter', 'none')`),
  check("invoices_split_ck", sql`(${table.supply} = 'inter' and ${table.cgstMinor} = 0 and ${table.sgstMinor} = 0) or (${table.supply} <> 'inter' and ${table.igstMinor} = 0)`),
  check("invoices_total_ck", sql`${table.totalMinor} = ${table.taxableMinor} + ${table.cgstMinor} + ${table.sgstMinor} + ${table.igstMinor} and ${table.taxableMinor} >= 0 and ${table.cgstMinor} >= 0 and ${table.sgstMinor} >= 0 and ${table.igstMinor} >= 0`),
  check("invoices_sequence_ck", sql`${table.sequence} > 0`),
]);

export const invoiceLines = pgTable("invoice_lines", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  invoiceId: text("invoice_id").notNull(),
  position: smallint("position").notNull(),
  description: varchar("description", { length: 200 }).notNull(),
  /** HSN for goods, SAC for services. */
  sacCode: varchar("sac_code", { length: 8 }),
  quantity: integer("quantity").notNull(),
  /** One unit as entered, before the discount. */
  unitPriceMinor: integer("unit_price_minor").notNull(),
  discountMinor: integer("discount_minor").notNull().default(0),
  treatment: varchar("treatment", { length: 8 }).notNull(),
  rateBps: smallint("rate_bps").notNull().default(0),
  taxableMinor: integer("taxable_minor").notNull(),
  cgstMinor: integer("cgst_minor").notNull().default(0),
  sgstMinor: integer("sgst_minor").notNull().default(0),
  igstMinor: integer("igst_minor").notNull().default(0),
  totalMinor: integer("total_minor").notNull(),
}, (table) => [
  foreignKey({ name: "invoice_lines_invoice_fk", columns: [table.tenantId, table.invoiceId], foreignColumns: [invoices.tenantId, invoices.id] }).onDelete("restrict"),
  unique("invoice_lines_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("invoice_lines_position_uq").on(table.invoiceId, table.position),
  check("invoice_lines_treatment_ck", sql`${table.treatment} in ('taxable', 'exempt', 'nil')`),
  check("invoice_lines_total_ck", sql`${table.totalMinor} = ${table.taxableMinor} + ${table.cgstMinor} + ${table.sgstMinor} + ${table.igstMinor} and ${table.quantity} > 0 and ${table.unitPriceMinor} >= 0 and ${table.discountMinor} >= 0`),
]);

/** A correction to an issued invoice. Credits whole lines, so the tax it reverses is exactly what was charged. */
export const creditNotes = pgTable("credit_notes", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
  invoiceId: text("invoice_id").notNull(),
  financialYear: varchar("financial_year", { length: 7 }).notNull(),
  series: varchar("series", { length: 4 }).notNull().default("CN"),
  sequence: integer("sequence").notNull(),
  number: varchar("number", { length: 24 }).notNull(),
  /** Free text from staff: stays here, never in the activity log. */
  reason: varchar("reason", { length: 200 }).notNull(),
  taxableMinor: integer("taxable_minor").notNull(),
  cgstMinor: integer("cgst_minor").notNull().default(0),
  sgstMinor: integer("sgst_minor").notNull().default(0),
  igstMinor: integer("igst_minor").notNull().default(0),
  totalMinor: integer("total_minor").notNull(),
  issuedByUserId: text("issued_by_user_id"),
  issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ name: "credit_notes_invoice_fk", columns: [table.tenantId, table.invoiceId], foreignColumns: [invoices.tenantId, invoices.id] }).onDelete("restrict"),
  unique("credit_notes_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("credit_notes_number_uq").on(table.tenantId, table.number),
  uniqueIndex("credit_notes_sequence_uq").on(table.tenantId, table.financialYear, table.series, table.sequence),
  index("credit_notes_invoice_idx").on(table.tenantId, table.invoiceId),
  check("credit_notes_total_ck", sql`${table.totalMinor} = ${table.taxableMinor} + ${table.cgstMinor} + ${table.sgstMinor} + ${table.igstMinor} and ${table.totalMinor} > 0`),
]);

export const creditNoteLines = pgTable("credit_note_lines", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  creditNoteId: text("credit_note_id").notNull(),
  /** One invoice line can be credited once. */
  invoiceLineId: text("invoice_line_id").notNull(),
  taxableMinor: integer("taxable_minor").notNull(),
  cgstMinor: integer("cgst_minor").notNull().default(0),
  sgstMinor: integer("sgst_minor").notNull().default(0),
  igstMinor: integer("igst_minor").notNull().default(0),
  totalMinor: integer("total_minor").notNull(),
}, (table) => [
  foreignKey({ name: "credit_note_lines_note_fk", columns: [table.tenantId, table.creditNoteId], foreignColumns: [creditNotes.tenantId, creditNotes.id] }).onDelete("restrict"),
  foreignKey({ name: "credit_note_lines_line_fk", columns: [table.tenantId, table.invoiceLineId], foreignColumns: [invoiceLines.tenantId, invoiceLines.id] }).onDelete("restrict"),
  unique("credit_note_lines_line_uq").on(table.tenantId, table.invoiceLineId),
  check("credit_note_lines_total_ck", sql`${table.totalMinor} = ${table.taxableMinor} + ${table.cgstMinor} + ${table.sgstMinor} + ${table.igstMinor}`),
]);

/** The rendered PDF of an invoice or credit note, written once by the worker. The file is encrypted in the file store. */
export const invoiceDocuments = pgTable("invoice_documents", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  invoiceId: text("invoice_id"),
  creditNoteId: text("credit_note_id"),
  fileKey: varchar("file_key", { length: 200 }).notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({ name: "invoice_documents_invoice_fk", columns: [table.tenantId, table.invoiceId], foreignColumns: [invoices.tenantId, invoices.id] }).onDelete("restrict"),
  foreignKey({ name: "invoice_documents_note_fk", columns: [table.tenantId, table.creditNoteId], foreignColumns: [creditNotes.tenantId, creditNotes.id] }).onDelete("restrict"),
  uniqueIndex("invoice_documents_invoice_uq").on(table.tenantId, table.invoiceId).where(sql`${table.invoiceId} is not null`),
  uniqueIndex("invoice_documents_note_uq").on(table.tenantId, table.creditNoteId).where(sql`${table.creditNoteId} is not null`),
  check("invoice_documents_one_ck", sql`(${table.invoiceId} is null) <> (${table.creditNoteId} is null)`),
]);

/** A tokenised link a customer opens to get the PDF. Only the hash of the 256-bit token is kept. */
export const invoiceLinks = pgTable("invoice_links", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  invoiceId: text("invoice_id"),
  creditNoteId: text("credit_note_id"),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdByUserId: text("created_by_user_id"),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({ name: "invoice_links_invoice_fk", columns: [table.tenantId, table.invoiceId], foreignColumns: [invoices.tenantId, invoices.id] }).onDelete("restrict"),
  foreignKey({ name: "invoice_links_note_fk", columns: [table.tenantId, table.creditNoteId], foreignColumns: [creditNotes.tenantId, creditNotes.id] }).onDelete("restrict"),
  uniqueIndex("invoice_links_token_uq").on(table.tokenHash),
  check("invoice_links_one_ck", sql`(${table.invoiceId} is null) <> (${table.creditNoteId} is null)`),
]);

/** A prepaid bundle on sale (feature 25): a number of credits for chosen services, valid for a number of days. */
export const packages = pgTable("packages", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  description: varchar("description", { length: 400 }),
  /** What the customer pays, in the smallest unit, tax included (see the tax settings). */
  priceMinor: integer("price_minor").notNull(),
  credits: smallint("credits").notNull(),
  validDays: smallint("valid_days").notNull(),
  /** Services a credit can be spent on. */
  serviceIds: text("service_ids").array().notNull(),
  isActive: boolean("is_active").notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("packages_tenant_id_id_uq").on(table.tenantId, table.id),
  check("packages_price_ck", sql`${table.priceMinor} > 0`),
  check("packages_credits_ck", sql`${table.credits} between 1 and 200`),
  check("packages_valid_ck", sql`${table.validDays} between 1 and 3650`),
  check("packages_services_ck", sql`cardinality(${table.serviceIds}) between 1 and 100`),
]);

/**
 * One package a customer holds. What was bought is copied here, so changing the package later never changes what
 * they own. The balance is not stored: it is the sum of `customer_credits` for this row.
 */
export const customerPackages = pgTable("customer_packages", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  patientId: text("patient_id").notNull(),
  packageId: text("package_id"),
  /** Set for the credits a membership grants each period. */
  membershipId: text("membership_id"),
  periodStart: timestamp("period_start", { withTimezone: true, mode: "date" }),
  source: varchar("source", { length: 10 }).notNull().default("package"),
  name: varchar("name", { length: 120 }).notNull(),
  creditsTotal: smallint("credits_total").notNull(),
  priceMinor: integer("price_minor").notNull().default(0),
  serviceIds: text("service_ids").array().notNull(),
  boughtAt: timestamp("bought_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  invoiceId: text("invoice_id"),
  soldByUserId: text("sold_by_user_id"),
  /** When the 14-day and 3-day reminders were queued, so each goes out once. */
  reminded14At: timestamp("reminded_14_at", { withTimezone: true, mode: "date" }),
  reminded3At: timestamp("reminded_3_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  foreignKey({ name: "customer_packages_patient_fk", columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id] }).onDelete("restrict"),
  foreignKey({ name: "customer_packages_package_fk", columns: [table.tenantId, table.packageId], foreignColumns: [packages.tenantId, packages.id] }).onDelete("restrict"),
  foreignKey({ name: "customer_packages_membership_fk", columns: [table.tenantId, table.membershipId], foreignColumns: [customerMemberships.tenantId, customerMemberships.id] }).onDelete("restrict"),
  foreignKey({ name: "customer_packages_invoice_fk", columns: [table.tenantId, table.invoiceId], foreignColumns: [invoices.tenantId, invoices.id] }).onDelete("restrict"),
  unique("customer_packages_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("customer_packages_period_uq").on(table.tenantId, table.membershipId, table.periodStart).where(sql`${table.membershipId} is not null`),
  index("customer_packages_patient_idx").on(table.tenantId, table.patientId, table.expiresAt),
  index("customer_packages_expiry_idx").on(table.expiresAt),
  check("customer_packages_source_ck", sql`${table.source} in ('package', 'membership', 'gift')`),
  check("customer_packages_credits_ck", sql`${table.creditsTotal} between 1 and 200 and ${table.priceMinor} >= 0`),
]);

/**
 * The credit ledger. Rows are only ever added: a balance is the sum of `change`, so every figure can be explained and a
 * double click cannot corrupt it. A trigger refuses edits, deletes and any row that would take a package below zero.
 */
export const customerCredits = pgTable("customer_credits", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  customerPackageId: text("customer_package_id").notNull(),
  change: smallint("change").notNull(),
  /** `purchase`, `renewal`, `grant`, `use`, `return`, `expiry` or `adjust`. */
  kind: varchar("kind", { length: 10 }).notNull(),
  appointmentId: text("appointment_id"),
  /** Plain words from a short fixed list or the desk, shown in the balance history. */
  reason: varchar("reason", { length: 200 }).notNull(),
  actorUserId: text("actor_user_id"),
  /** Makes a repeat of the same event (a renewal webhook delivered twice, a second expiry run) a no-op. */
  dedupeKey: varchar("dedupe_key", { length: 160 }),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({ name: "customer_credits_package_fk", columns: [table.tenantId, table.customerPackageId], foreignColumns: [customerPackages.tenantId, customerPackages.id] }).onDelete("restrict"),
  foreignKey({ name: "customer_credits_appointment_fk", columns: [table.tenantId, table.appointmentId], foreignColumns: [appointments.tenantId, appointments.id] }).onDelete("restrict"),
  unique("customer_credits_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("customer_credits_use_uq").on(table.tenantId, table.customerPackageId, table.appointmentId).where(sql`${table.kind} = 'use'`),
  uniqueIndex("customer_credits_return_uq").on(table.tenantId, table.customerPackageId, table.appointmentId).where(sql`${table.kind} = 'return'`),
  uniqueIndex("customer_credits_dedupe_uq").on(table.tenantId, table.dedupeKey).where(sql`${table.dedupeKey} is not null`),
  index("customer_credits_package_idx").on(table.tenantId, table.customerPackageId, table.createdAt),
  check("customer_credits_kind_ck", sql`${table.kind} in ('purchase', 'renewal', 'grant', 'use', 'return', 'expiry', 'adjust')`),
  check("customer_credits_sign_ck", sql`${table.change} <> 0 and (
    (${table.kind} in ('purchase', 'renewal', 'grant', 'return') and ${table.change} > 0) or
    (${table.kind} in ('use', 'expiry') and ${table.change} < 0) or ${table.kind} = 'adjust')`),
]);

/** A monthly membership on sale: credits each period, a member price on chosen services, or both. */
export const membershipPlans = pgTable("membership_plans", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  description: varchar("description", { length: 400 }),
  /** Charged every month. */
  priceMinor: integer("price_minor").notNull(),
  creditsPerPeriod: smallint("credits_per_period").notNull().default(0),
  /** Percent off the services below while the membership is in good standing. 0 for none. */
  memberDiscountPercent: smallint("member_discount_percent").notNull().default(0),
  serviceIds: text("service_ids").array().notNull(),
  isActive: boolean("is_active").notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("membership_plans_tenant_id_id_uq").on(table.tenantId, table.id),
  check("membership_plans_price_ck", sql`${table.priceMinor} > 0`),
  check("membership_plans_benefit_ck", sql`${table.creditsPerPeriod} between 0 and 100 and ${table.memberDiscountPercent} between 0 and 100 and (${table.creditsPerPeriod} > 0 or ${table.memberDiscountPercent} > 0)`),
  check("membership_plans_services_ck", sql`cardinality(${table.serviceIds}) between 1 and 100`),
]);

/** One customer's membership. Status and period move with the provider's subscription events. */
export const customerMemberships = pgTable("customer_memberships", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  patientId: text("patient_id").notNull(),
  planId: text("plan_id").notNull(),
  provider: varchar("provider", { length: 12 }).notNull(),
  providerSubscriptionId: varchar("provider_subscription_id", { length: 120 }).notNull(),
  /** `active`, `past_due` (7 days' grace), `paused` (benefits off) or `cancelled`. */
  status: varchar("status", { length: 10 }).notNull().default("active"),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true, mode: "date" }).notNull(),
  pastDueSince: timestamp("past_due_since", { withTimezone: true, mode: "date" }),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
  createdByUserId: text("created_by_user_id"),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({ name: "customer_memberships_patient_fk", columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id] }).onDelete("restrict"),
  foreignKey({ name: "customer_memberships_plan_fk", columns: [table.tenantId, table.planId], foreignColumns: [membershipPlans.tenantId, membershipPlans.id] }).onDelete("restrict"),
  unique("customer_memberships_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("customer_memberships_subscription_uq").on(table.provider, table.providerSubscriptionId),
  index("customer_memberships_patient_idx").on(table.tenantId, table.patientId, table.status),
  check("customer_memberships_status_ck", sql`${table.status} in ('active', 'past_due', 'paused', 'cancelled')`),
]);

/** Every subscription event a provider sent, one row per provider event id, so a repeat does nothing. Cut down to ids and amounts. */
export const membershipEvents = pgTable("membership_events", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  provider: varchar("provider", { length: 12 }).notNull(),
  providerEventId: varchar("provider_event_id", { length: 120 }).notNull(),
  type: varchar("type", { length: 40 }).notNull(),
  membershipId: text("membership_id"),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("membership_events_event_uq").on(table.provider, table.providerEventId),
  index("membership_events_membership_idx").on(table.tenantId, table.membershipId),
]);

/** A discount code. Redemptions are counted under a lock on this row, so a 100-use code stops at 100. */
export const coupons = pgTable("coupons", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  /** Stored in capitals; customers may type it in any case. */
  code: varchar("code", { length: 32 }).notNull(),
  /** `percent` (value 1 to 100) or `fixed` (value in the smallest unit). */
  kind: varchar("kind", { length: 7 }).notNull(),
  value: integer("value").notNull(),
  maxUses: integer("max_uses"),
  perCustomerLimit: smallint("per_customer_limit"),
  validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }),
  validTo: timestamp("valid_to", { withTimezone: true, mode: "date" }),
  /** Empty means every service. */
  serviceIds: text("service_ids").array().notNull().default(sql`ARRAY[]::text[]`),
  firstVisitOnly: boolean("first_visit_only").notNull().default(false),
  /** May be used on top of a member price. Off by default: one discount per booking. */
  stackable: boolean("stackable").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("coupons_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("coupons_code_uq").on(table.tenantId, table.code),
  check("coupons_kind_ck", sql`${table.kind} in ('percent', 'fixed')`),
  check("coupons_value_ck", sql`(${table.kind} = 'percent' and ${table.value} between 1 and 100) or (${table.kind} = 'fixed' and ${table.value} > 0)`),
  check("coupons_limits_ck", sql`(${table.maxUses} is null or ${table.maxUses} > 0) and (${table.perCustomerLimit} is null or ${table.perCustomerLimit} > 0)`),
  check("coupons_dates_ck", sql`${table.validFrom} is null or ${table.validTo} is null or ${table.validFrom} < ${table.validTo}`),
]);

/** A code used on a booking. Released (not deleted) when the booking is cancelled or expires, so it stops counting. */
export const couponRedemptions = pgTable("coupon_redemptions", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  couponId: text("coupon_id").notNull(),
  appointmentId: text("appointment_id").notNull(),
  patientId: text("patient_id").notNull(),
  discountMinor: integer("discount_minor").notNull(),
  releasedAt: timestamp("released_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({ name: "coupon_redemptions_coupon_fk", columns: [table.tenantId, table.couponId], foreignColumns: [coupons.tenantId, coupons.id] }).onDelete("restrict"),
  foreignKey({ name: "coupon_redemptions_appointment_fk", columns: [table.tenantId, table.appointmentId], foreignColumns: [appointments.tenantId, appointments.id] }).onDelete("restrict"),
  foreignKey({ name: "coupon_redemptions_patient_fk", columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id] }).onDelete("restrict"),
  unique("coupon_redemptions_coupon_appointment_uq").on(table.tenantId, table.couponId, table.appointmentId),
  index("coupon_redemptions_count_idx").on(table.tenantId, table.couponId).where(sql`${table.releasedAt} is null`),
  index("coupon_redemptions_patient_idx").on(table.tenantId, table.couponId, table.patientId),
  check("coupon_redemptions_discount_ck", sql`${table.discountMinor} > 0`),
]);

/**
 * How a booking's price came to be: the list price and each discount taken off it, in the fixed order member price,
 * then coupon (then tax, on the invoice). The booking's own `price_minor` is the price after these. Written once.
 */
export const appointmentDiscounts = pgTable("appointment_discounts", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  appointmentId: text("appointment_id").notNull(),
  /** `member_price`, `coupon` or `package` (a credit covers the whole price). */
  kind: varchar("kind", { length: 12 }).notNull(),
  listPriceMinor: integer("list_price_minor").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  couponId: text("coupon_id"),
  membershipId: text("membership_id"),
  customerPackageId: text("customer_package_id"),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({ name: "appointment_discounts_appointment_fk", columns: [table.tenantId, table.appointmentId], foreignColumns: [appointments.tenantId, appointments.id] }).onDelete("restrict"),
  unique("appointment_discounts_kind_uq").on(table.tenantId, table.appointmentId, table.kind),
  check("appointment_discounts_kind_ck", sql`${table.kind} in ('member_price', 'coupon', 'package')`),
  check("appointment_discounts_amount_ck", sql`${table.amountMinor} > 0 and ${table.listPriceMinor} > 0`),
]);

/**
 * Contacts staff have blocked (feature 44). The value is stored only as a keyed hash of its normal form, so the table
 * cannot be read back into a contact list; `hint` is the short masked form staff recognise it by.
 */
export const blocklistEntries = pgTable("blocklist_entries", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
  kind: varchar("kind", { length: 12 }).notNull(),
  valueHash: varchar("value_hash", { length: 64 }).notNull(),
  hint: varchar("hint", { length: 80 }).notNull(),
  reasonCode: varchar("reason_code", { length: 16 }).notNull(),
  addedByUserId: text("added_by_user_id"),
  createdAt: createdAt(),
}, (table) => [
  unique("blocklist_entries_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("blocklist_entries_value_uq").on(table.tenantId, table.kind, table.valueHash),
  check("blocklist_entries_kind_valid", sql`${table.kind} in ('email', 'phone', 'email_domain')`),
  check("blocklist_entries_reason_valid", sql`${table.reasonCode} in ('fake_details', 'abusive', 'duplicate', 'other')`),
]);

/** A booking staff flagged as spam, waiting for an admin's decision (feature 44). */
export const bookingReports = pgTable("booking_reports", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  appointmentId: text("appointment_id").notNull(),
  patientId: text("patient_id").notNull(),
  reportedByUserId: text("reported_by_user_id"),
  reasonCode: varchar("reason_code", { length: 16 }).notNull(),
  status: varchar("status", { length: 8 }).notNull().default("open"),
  decidedByUserId: text("decided_by_user_id"),
  decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
}, (table) => [
  unique("booking_reports_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("booking_reports_appointment_uq").on(table.tenantId, table.appointmentId),
  index("booking_reports_status_idx").on(table.tenantId, table.status, table.createdAt),
  check("booking_reports_reason_valid", sql`${table.reasonCode} in ('fake_details', 'abusive', 'duplicate', 'other')`),
  check("booking_reports_status_valid", sql`${table.status} in ('open', 'ignored', 'blocked')`),
  check("booking_reports_decision_pair", sql`(${table.status} = 'open') = (${table.decidedAt} is null)`),
  foreignKey({
    name: "booking_reports_appointment_fk",
    columns: [table.tenantId, table.appointmentId],
    foreignColumns: [appointments.tenantId, appointments.id],
  }).onDelete("restrict"),
  foreignKey({
    name: "booking_reports_patient_fk",
    columns: [table.tenantId, table.patientId],
    foreignColumns: [patients.tenantId, patients.id],
  }).onDelete("restrict"),
]);

/**
 * A link that books one service under its own rules (feature 45): once, a few times, or until a date. The token is
 * 256 random bits shown once at creation; only its SHA-256 hash is stored. `used_count` is only ever changed by the
 * booking transaction's conditional update, so two people on a single-use link cannot both book.
 */
export const specialLinks = pgTable("special_links", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  serviceId: text("service_id").notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  label: varchar("label", { length: 80 }).notNull(),
  kind: varchar("kind", { length: 10 }).notNull(),
  maxUses: integer("max_uses"),
  usedCount: integer("used_count").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  createdByUserId: text("created_by_user_id"),
  createdAt: createdAt(),
}, (table) => [
  unique("special_links_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("special_links_token_hash_uq").on(table.tokenHash),
  index("special_links_service_idx").on(table.tenantId, table.serviceId, table.createdAt),
  check("special_links_kind_valid", sql`${table.kind} in ('single_use', 'limited', 'expiring')`),
  check("special_links_shape_ck", sql`(${table.kind} = 'single_use' and ${table.maxUses} = 1)
    or (${table.kind} = 'limited' and ${table.maxUses} between 2 and 1000)
    or (${table.kind} = 'expiring' and ${table.maxUses} is null and ${table.expiresAt} is not null)`),
  check("special_links_used_ck", sql`${table.usedCount} >= 0 and (${table.maxUses} is null or ${table.usedCount} <= ${table.maxUses})`),
  foreignKey({
    name: "special_links_service_fk",
    columns: [table.tenantId, table.serviceId],
    foreignColumns: [services.tenantId, services.id],
  }).onDelete("restrict"),
]);

/** A booking link for two to four people at once (feature 45): only times all of them are free are offered. */
export const combinedLinks = pgTable("combined_links", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  slug: varchar("slug", { length: 60 }).notNull(),
  label: varchar("label", { length: 80 }).notNull(),
  serviceId: text("service_id").notNull(),
  practitionerIds: text("practitioner_ids").array().notNull(),
  createdByUserId: text("created_by_user_id"),
  createdAt: createdAt(),
}, (table) => [
  unique("combined_links_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("combined_links_slug_uq").on(table.tenantId, table.slug),
  check("combined_links_people_ck", sql`cardinality(${table.practitionerIds}) between 2 and 4`),
  check("combined_links_slug_ck", sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  foreignKey({
    name: "combined_links_service_fk",
    columns: [table.tenantId, table.serviceId],
    foreignColumns: [services.tenantId, services.id],
  }).onDelete("restrict"),
]);

/**
 * A service defined once (feature 48). `settings` is validated by `templateSettingsSchema`; `locked_fields` names the parts
 * of every copy that only the template may change. Bookings always point at real services, never at a template.
 */
export const serviceTemplates = pgTable("service_templates", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
  name: varchar("name", { length: 120 }).notNull(),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull(),
  lockedFields: text("locked_fields").array().notNull().default(sql`'{}'::text[]`),
  version: integer("version").notNull().default(1),
  createdByUserId: text("created_by_user_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("service_templates_tenant_id_id_uq").on(table.tenantId, table.id),
  index("service_templates_tenant_idx").on(table.tenantId, table.name),
  check("service_templates_version_ck", sql`${table.version} > 0`),
]);

/** One dated occurrence of a class (feature 18). It holds its teacher and room through `resource_reservations`, like a visit does. */
export const classSessions = pgTable("class_sessions", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  serviceId: text("service_id").notNull(),
  practitionerId: text("practitioner_id").notNull(),
  locationId: text("location_id").notNull(),
  resourceId: text("resource_id"),
  startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
  capacity: smallint("capacity").notNull(),
  status: varchar("status", { length: 10 }).notNull().default("scheduled"),
  /** Sessions made together as one repeating timetable share this id. */
  seriesId: text("series_id"),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("class_sessions_tenant_id_id_uq").on(table.tenantId, table.id),
  check("class_sessions_time_order", sql`${table.endsAt} > ${table.startsAt}`),
  check("class_sessions_capacity_range", sql`${table.capacity} between 1 and 500`),
  check("class_sessions_status_valid", sql`${table.status} in ('scheduled', 'cancelled', 'completed')`),
  foreignKey({ name: "class_sessions_service_fk", columns: [table.tenantId, table.serviceId], foreignColumns: [services.tenantId, services.id] }).onDelete("restrict"),
  foreignKey({ name: "class_sessions_practitioner_fk", columns: [table.tenantId, table.practitionerId], foreignColumns: [practitioners.tenantId, practitioners.id] }).onDelete("restrict"),
  foreignKey({ name: "class_sessions_location_fk", columns: [table.tenantId, table.locationId], foreignColumns: [locations.tenantId, locations.id] }).onDelete("restrict"),
  foreignKey({ name: "class_sessions_resource_fk", columns: [table.tenantId, table.resourceId], foreignColumns: [resources.tenantId, resources.id] }).onDelete("restrict"),
  index("class_sessions_timetable_idx").on(table.tenantId, table.startsAt),
  index("class_sessions_service_idx").on(table.tenantId, table.serviceId, table.startsAt),
  index("class_sessions_series_idx").on(table.tenantId, table.seriesId).where(sql`${table.seriesId} is not null`),
]);

/** One customer's place in one session: a seat, a spot on the waiting list, or the record of either (feature 18). */
export const classEnrolments = pgTable("class_enrolments", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  sessionId: text("session_id").notNull(),
  patientId: text("patient_id").notNull(),
  status: varchar("status", { length: 10 }).notNull(),
  /** Only the hash is looked up; the sealed copy lets the worker put the link in a message. */
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  tokenSealed: text("token_sealed"),
  source: varchar("source", { length: 10 }).notNull().default("online"),
  /** A waiting person holding a freed seat until this time. */
  offerExpiresAt: timestamp("offer_expires_at", { withTimezone: true, mode: "date" }),
  offeredAt: timestamp("offered_at", { withTimezone: true, mode: "date" }),
  /** Set when an offer lapsed or was turned down: the person is passed over for later seats too. */
  offerPassedAt: timestamp("offer_passed_at", { withTimezone: true, mode: "date" }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
  cancelledBy: varchar("cancelled_by", { length: 10 }),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("class_enrolments_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("class_enrolments_session_customer_uq").on(table.tenantId, table.sessionId, table.patientId),
  unique("class_enrolments_token_uq").on(table.tokenHash),
  check("class_enrolments_status_valid", sql`${table.status} in ('booked', 'waitlisted', 'attended', 'cancelled', 'no_show')`),
  check("class_enrolments_source_valid", sql`${table.source} in ('online', 'staff', 'walk_in')`),
  check("class_enrolments_cancelled_by_valid", sql`${table.cancelledBy} is null or ${table.cancelledBy} in ('customer', 'business')`),
  check("class_enrolments_offer_only_waiting", sql`${table.offerExpiresAt} is null or ${table.status} = 'waitlisted'`),
  foreignKey({ name: "class_enrolments_session_fk", columns: [table.tenantId, table.sessionId], foreignColumns: [classSessions.tenantId, classSessions.id] }).onDelete("cascade"),
  foreignKey({ name: "class_enrolments_patient_fk", columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id] }).onDelete("restrict"),
  index("class_enrolments_session_idx").on(table.tenantId, table.sessionId, table.status, table.createdAt),
  index("class_enrolments_patient_idx").on(table.tenantId, table.patientId),
]);

/**
 * The tracking ids a business enters for its public booking pages (feature 52). Ids only, never script code: the
 * page adds each provider's official snippet itself, and only after the visitor accepts analytics cookies.
 */
export const trackingSettings = pgTable("tracking_settings", {
  tenantId: text("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }),
  googleAnalyticsId: varchar("google_analytics_id", { length: 24 }),
  tagManagerId: varchar("tag_manager_id", { length: 20 }),
  metaPixelId: varchar("meta_pixel_id", { length: 20 }),
  plausibleDomain: varchar("plausible_domain", { length: 120 }),
  version: integer("version").notNull().default(1),
  updatedAt: updatedAt(),
}, (table) => [
  check("tracking_settings_ga_ck", sql`${table.googleAnalyticsId} is null or ${table.googleAnalyticsId} ~ '^(G|UA|AW)-[A-Z0-9-]{4,20}$'`),
  check("tracking_settings_gtm_ck", sql`${table.tagManagerId} is null or ${table.tagManagerId} ~ '^GTM-[A-Z0-9]{4,12}$'`),
  check("tracking_settings_meta_ck", sql`${table.metaPixelId} is null or ${table.metaPixelId} ~ '^[0-9]{8,20}$'`),
  check("tracking_settings_plausible_ck", sql`${table.plausibleDomain} is null or ${table.plausibleDomain} ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'`),
]);

/**
 * Short links for printed cards and bio links (/s/abc1234): each opens one of the business's booking pages, with
 * optional prefill and a campaign tag (feature 52). Clicks are counted; no address or visitor detail is stored.
 * Named apart from `short_links`, which holds the SMS manage links.
 */
export const bookingShortLinks = pgTable("booking_short_links", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  /** Seven random characters, unique across all businesses because the link carries no business name. */
  code: varchar("code", { length: 7 }).notNull(),
  label: varchar("label", { length: 80 }).notNull(),
  /** A path on this site, always under the business's own booking page: `/book/<slug>[/<service>]?…`. */
  targetPath: varchar("target_path", { length: 600 }).notNull(),
  createdByUserId: text("created_by_user_id"),
  clicks: integer("clicks").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
}, (table) => [
  unique("booking_short_links_code_uq").on(table.code),
  unique("booking_short_links_tenant_id_id_uq").on(table.tenantId, table.id),
  check("booking_short_links_code_ck", sql`${table.code} ~ '^[a-z2-9]{7}$'`),
  check("booking_short_links_path_ck", sql`${table.targetPath} ~ '^/book/[a-z0-9-]+(/[a-z0-9-]+)?(\\?.*)?$'`),
  index("booking_short_links_tenant_idx").on(table.tenantId, table.createdAt),
]);

/**
 * The AI booking assistant's settings, one row per business (feature 30). It is off until the owner turns a channel on.
 * The business facts are the owner's own words and reach the model as data, never as rules.
 */
export const assistantSettings = pgTable("assistant_settings", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  enabledWeb: boolean("enabled_web").notNull().default(false),
  enabledWhatsapp: boolean("enabled_whatsapp").notNull().default(false),
  enabledSms: boolean("enabled_sms").notNull().default(false),
  tone: varchar("tone", { length: 12 }).notNull().default("friendly"),
  handoffRule: varchar("handoff_rule", { length: 10 }).notNull().default("balanced"),
  businessFacts: text("business_facts"),
  /** How long a conversation is kept after its last message. */
  retentionDays: smallint("retention_days").notNull().default(90),
  version: integer("version").notNull().default(1),
  updatedByUserId: text("updated_by_user_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("assistant_settings_tenant_uq").on(table.tenantId),
  unique("assistant_settings_tenant_id_id_uq").on(table.tenantId, table.id),
  check("assistant_settings_tone_ck", sql`${table.tone} in ('friendly', 'professional', 'concise')`),
  check("assistant_settings_handoff_ck", sql`${table.handoffRule} in ('balanced', 'eager')`),
  check("assistant_settings_retention_ck", sql`${table.retentionDays} between 7 and 730`),
  check("assistant_settings_facts_ck", sql`${table.businessFacts} is null or char_length(${table.businessFacts}) <= 3000`),
]);

/**
 * One chat with the assistant: a web visitor (a 256-bit token, stored as a hash), a customer's WhatsApp or text thread,
 * or a staff member using the copilot. A confirmation the customer still owes, and the proposal behind it, are sealed
 * with the business's key. The model can never commit a change: only the customer's own confirm can.
 */
export const assistantConversations = pgTable("assistant_conversations", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  channel: varchar("channel", { length: 10 }).notNull(),
  tokenHash: varchar("token_hash", { length: 64 }),
  patientId: text("patient_id"),
  threadId: text("thread_id"),
  staffUserId: text("staff_user_id"),
  status: varchar("status", { length: 12 }).notNull().default("active"),
  handedOffAt: timestamp("handed_off_at", { withTimezone: true, mode: "date" }),
  handoffReason: varchar("handoff_reason", { length: 24 }),
  summaryCiphertext: text("summary_ciphertext"),
  summaryKeyVersion: integer("summary_key_version"),
  turnCount: integer("turn_count").notNull().default(0),
  failureCount: smallint("failure_count").notNull().default(0),
  /** The proposal waiting for the customer's confirm, sealed. Its id is what the Confirm button sends. */
  pendingId: varchar("pending_id", { length: 64 }),
  pendingCiphertext: text("pending_ciphertext"),
  pendingKeyVersion: integer("pending_key_version"),
  pendingExpiresAt: timestamp("pending_expires_at", { withTimezone: true, mode: "date" }),
  /** A phone number a code was sent to (sealed), and the proof once the customer entered the code. */
  otpPhoneCiphertext: text("otp_phone_ciphertext"),
  otpKeyVersion: integer("otp_key_version"),
  otpSentAt: timestamp("otp_sent_at", { withTimezone: true, mode: "date" }),
  verifiedPatientIds: text("verified_patient_ids").array().notNull().default(sql`'{}'::text[]`),
  verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
  /** Booking ids find_my_bookings has shown in this chat: the only ones a move or cancel may name. */
  shownAppointmentIds: text("shown_appointment_ids").array().notNull().default(sql`'{}'::text[]`),
  leaseUntil: timestamp("lease_until", { withTimezone: true, mode: "date" }),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("assistant_conversations_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("assistant_conversations_token_uq").on(table.tokenHash),
  foreignKey({
    name: "assistant_conversations_patient_fk",
    columns: [table.tenantId, table.patientId],
    foreignColumns: [patients.tenantId, patients.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "assistant_conversations_thread_fk",
    columns: [table.tenantId, table.threadId],
    foreignColumns: [messageThreads.tenantId, messageThreads.id],
  }).onDelete("cascade"),
  check("assistant_conversations_channel_ck", sql`${table.channel} in ('web', 'whatsapp', 'sms', 'staff')`),
  check("assistant_conversations_status_ck", sql`${table.status} in ('active', 'handed_off', 'closed')`),
  index("assistant_conversations_inbox_idx").on(table.tenantId, table.status, table.lastActivityAt),
  index("assistant_conversations_thread_idx").on(table.tenantId, table.threadId),
  index("assistant_conversations_patient_idx").on(table.tenantId, table.patientId),
]);

/**
 * One turn of a conversation, sealed. `content` is the model API's own block list (text, tool calls, tool results) as
 * JSON, kept exactly as sent so a later turn replays it unchanged. `kind` says who really spoke: a tool result is
 * carried as a user turn but is not the customer.
 */
export const assistantMessages = pgTable("assistant_messages", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  conversationId: text("conversation_id").notNull(),
  seq: integer("seq").notNull(),
  kind: varchar("kind", { length: 10 }).notNull(),
  contentCiphertext: text("content_ciphertext").notNull(),
  keyVersion: integer("key_version"),
  /** The provider's message id for an inbound text, so a repeated webhook adds nothing. */
  sourceKey: varchar("source_key", { length: 160 }),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({
    name: "assistant_messages_conversation_fk",
    columns: [table.tenantId, table.conversationId],
    foreignColumns: [assistantConversations.tenantId, assistantConversations.id],
  }).onDelete("cascade"),
  unique("assistant_messages_seq_uq").on(table.conversationId, table.seq),
  unique("assistant_messages_source_uq").on(table.tenantId, table.conversationId, table.sourceKey),
  check("assistant_messages_kind_ck", sql`${table.kind} in ('customer', 'assistant', 'tool', 'staff')`),
  index("assistant_messages_conversation_idx").on(table.tenantId, table.conversationId, table.seq),
]);

/** What the assistant has used this month, for the spend cap. One row per business per month. */
export const assistantUsage = pgTable("assistant_usage", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  period: date("period", { mode: "string" }).notNull(),
  inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
  outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
  cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
  cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
  turns: integer("turns").notNull().default(0),
  updatedAt: updatedAt(),
}, (table) => [
  unique("assistant_usage_period_uq").on(table.tenantId, table.period),
  check("assistant_usage_period_ck", sql`extract(day from ${table.period}) = 1`),
]);

/**
 * Enterprise and teams (feature 53). Departments nest under branches or stand alone, have their own page and may be
 * private (the page books but lists no people). Not the same as `limit_teams`, which only group people for booking limits.
 */
export const teams = pgTable("teams", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  parentTeamId: text("parent_team_id"),
  /** The branch this department sits under, if any. */
  locationId: text("location_id"),
  name: varchar("name", { length: 120 }).notNull(),
  slug: varchar("slug", { length: 80 }).notNull(),
  description: text("description"),
  isPrivate: boolean("is_private").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("teams_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("teams_tenant_slug_uq").on(table.tenantId, table.slug),
  foreignKey({ name: "teams_parent_fk", columns: [table.tenantId, table.parentTeamId], foreignColumns: [table.tenantId, table.id] }).onDelete("restrict"),
  foreignKey({ name: "teams_location_fk", columns: [table.tenantId, table.locationId], foreignColumns: [locations.tenantId, locations.id] }).onDelete("set null"),
  check("teams_slug_ck", sql`${table.slug} ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'`),
  check("teams_not_own_parent_ck", sql`${table.parentTeamId} is null or ${table.parentTeamId} <> ${table.id}`),
]);

export const teamMembers = pgTable("team_members", {
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  teamId: text("team_id").notNull(),
  membershipId: text("membership_id").notNull(),
  createdAt: createdAt(),
}, (table) => [
  primaryKey({ name: "team_members_pk", columns: [table.tenantId, table.teamId, table.membershipId] }),
  foreignKey({ name: "team_members_team_fk", columns: [table.tenantId, table.teamId], foreignColumns: [teams.tenantId, teams.id] }).onDelete("cascade"),
  foreignKey({ name: "team_members_membership_fk", columns: [table.tenantId, table.membershipId], foreignColumns: [memberships.tenantId, memberships.id] }).onDelete("cascade"),
  index("team_members_membership_idx").on(table.tenantId, table.membershipId),
]);

/** A role the owner shaped: a built-in base plus the exact permission keys it holds. */
export const customRoles = pgTable("custom_roles", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 80 }).notNull(),
  description: varchar("description", { length: 240 }),
  /** Which built-in role the second-factor and owner rules treat people in this role as. Never "owner". */
  baseRole: membershipRole("base_role").notNull(),
  permissions: text("permissions").array().notNull().default(sql`'{}'::text[]`),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("custom_roles_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("custom_roles_tenant_name_uq").on(table.tenantId, table.name),
  check("custom_roles_base_not_owner_ck", sql`${table.baseRole} <> 'owner'`),
]);

/** A company email domain, proved by a DNS TXT record the worker checks (feature 53). The token is shown once; only its hash is kept. */
export const verifiedDomains = pgTable("verified_domains", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  domain: varchar("domain", { length: 253 }).notNull(),
  tokenHash: text("token_hash").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true, mode: "date" }),
  /** Why the last check did not pass, in plain words. */
  lastCheckNote: varchar("last_check_note", { length: 200 }),
  autoJoinEnabled: boolean("auto_join_enabled").notNull().default(false),
  autoJoinRole: membershipRole("auto_join_role").notNull().default("read_only"),
  /** Everyone with an address on this domain must use company sign-in, except the break-glass owner. */
  requireSso: boolean("require_sso").notNull().default(false),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("verified_domains_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("verified_domains_tenant_domain_uq").on(table.tenantId, table.domain),
  // A domain belongs to one business once it is proved, so company sign-in can never be pointed at the wrong one.
  uniqueIndex("verified_domains_proved_uq").on(table.domain).where(sql`${table.verifiedAt} is not null`),
  check("verified_domains_domain_ck", sql`${table.domain} = lower(${table.domain}) and ${table.domain} ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'`),
  check("verified_domains_auto_join_role_ck", sql`${table.autoJoinRole} not in ('owner', 'admin')`),
]);

/** One company sign-in connection per verified domain: SAML (the identity provider's address and certificate) or OIDC. */
export const ssoConnections = pgTable("sso_connections", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  domainId: text("domain_id").notNull(),
  kind: varchar("kind", { length: 8 }).notNull(),
  status: varchar("status", { length: 12 }).notNull().default("draft"),
  /** SAML: the provider's entity id, sign-in address and signing certificate (public). OIDC: the issuer address. */
  idpEntityId: varchar("idp_entity_id", { length: 500 }),
  idpSsoUrl: varchar("idp_sso_url", { length: 1000 }),
  idpCertificate: text("idp_certificate"),
  oidcIssuer: varchar("oidc_issuer", { length: 500 }),
  oidcClientId: varchar("oidc_client_id", { length: 300 }),
  /** Encrypted with record-crypto. Never returned by any route. */
  oidcClientSecretEnc: text("oidc_client_secret_enc"),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("sso_connections_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("sso_connections_domain_uq").on(table.tenantId, table.domainId),
  foreignKey({ name: "sso_connections_domain_fk", columns: [table.tenantId, table.domainId], foreignColumns: [verifiedDomains.tenantId, verifiedDomains.id] }).onDelete("cascade"),
  check("sso_connections_kind_ck", sql`${table.kind} in ('saml', 'oidc')`),
  check("sso_connections_status_ck", sql`${table.status} in ('draft', 'active', 'disabled')`),
  check("sso_connections_saml_ck", sql`${table.kind} <> 'saml' or (${table.idpEntityId} is not null and ${table.idpSsoUrl} is not null and ${table.idpCertificate} is not null)`),
  check("sso_connections_oidc_ck", sql`${table.kind} <> 'oidc' or (${table.oidcIssuer} is not null and ${table.oidcClientId} is not null and ${table.oidcClientSecretEnc} is not null)`),
]);

/** Bearer tokens for the company directory (SCIM). Only the SHA-256 hash is stored; the token is shown once. */
export const scimTokens = pgTable("scim_tokens", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 80 }).notNull(),
  tokenHash: text("token_hash").notNull(),
  prefix: varchar("prefix", { length: 12 }).notNull(),
  /** The role people created by the directory start with. */
  defaultRole: membershipRole("default_role").notNull().default("read_only"),
  createdByUserId: text("created_by_user_id"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
}, (table) => [
  unique("scim_tokens_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("scim_tokens_hash_uq").on(table.tokenHash),
  check("scim_tokens_default_role_ck", sql`${table.defaultRole} not in ('owner', 'admin')`),
]);

/** Things the owner records about each person: Language, Speciality, Seniority. Used by routing and as report filters. */
export const attributeDefinitions = pgTable("attribute_definitions", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 60 }).notNull(),
  kind: varchar("kind", { length: 12 }).notNull(),
  /** The choices, for the two choice kinds. */
  options: text("options").array().notNull().default(sql`'{}'::text[]`),
  position: integer("position").notNull().default(0),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("attribute_definitions_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("attribute_definitions_tenant_name_uq").on(table.tenantId, table.name),
  check("attribute_definitions_kind_ck", sql`${table.kind} in ('text', 'single', 'multiple', 'number')`),
]);

export const practitionerAttributes = pgTable("practitioner_attributes", {
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  practitionerId: text("practitioner_id").notNull(),
  attributeId: text("attribute_id").notNull(),
  /** A string for text, a number for number, an array of strings for the choice kinds. Checked by the server before it is stored. */
  value: jsonb("value").$type<string | number | string[]>().notNull(),
  updatedAt: updatedAt(),
}, (table) => [
  primaryKey({ name: "practitioner_attributes_pk", columns: [table.tenantId, table.practitionerId, table.attributeId] }),
  foreignKey({ name: "practitioner_attributes_practitioner_fk", columns: [table.tenantId, table.practitionerId], foreignColumns: [practitioners.tenantId, practitioners.id] }).onDelete("cascade"),
  foreignKey({ name: "practitioner_attributes_attribute_fk", columns: [table.tenantId, table.attributeId], foreignColumns: [attributeDefinitions.tenantId, attributeDefinitions.id] }).onDelete("cascade"),
]);

/**
 * A report export the worker is building or has built (feature 26). Large date ranges are not made inside the request: the
 * row says who asked and what they were allowed to see (`scope`), and the worker writes the CSV into `body`. The file is
 * downloaded from an authenticated route, only by the person who asked, and removed a day later.
 */
export const reportExports = pgTable("report_exports", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  requestedByUserId: text("requested_by_user_id").notNull(),
  report: varchar("report", { length: 24 }).notNull(),
  /** The range and filters asked for: `{ from, to, locationId?, practitionerId? }`. */
  params: jsonb("params").$type<Record<string, unknown>>().notNull(),
  /** What the person could see when they asked: `{ practitionerId, canSeeRevenue }`. The worker never exports more than this. */
  scope: jsonb("scope").$type<Record<string, unknown>>().notNull(),
  status: varchar("status", { length: 10 }).notNull().default("pending"),
  filename: varchar("filename", { length: 120 }),
  body: text("body"),
  failureCode: varchar("failure_code", { length: 40 }),
  createdAt: createdAt(),
  readyAt: timestamp("ready_at", { withTimezone: true, mode: "date" }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
}, (table) => [
  unique("report_exports_tenant_id_id_uq").on(table.tenantId, table.id),
  check("report_exports_status_ck", sql`${table.status} in ('pending', 'ready', 'failed')`),
  index("report_exports_user_idx").on(table.tenantId, table.requestedByUserId, table.createdAt),
]);

/**
 * The one-tap rating link sent after a finished visit (feature 51). One row per visit. The link's token is 256 bits: only its
 * hash is used to look the row up, and a sealed copy lets the worker put the same link in a retried message. `sent_at` also
 * drives the once-a-month limit per customer.
 */
export const ratingRequests = pgTable("rating_requests", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  appointmentId: text("appointment_id").notNull(),
  patientId: text("patient_id").notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  tokenCiphertext: text("token_ciphertext"),
  sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  openedAt: timestamp("opened_at", { withTimezone: true, mode: "date" }),
  answeredAt: timestamp("answered_at", { withTimezone: true, mode: "date" }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({ name: "rating_requests_appointment_fk", columns: [table.tenantId, table.appointmentId], foreignColumns: [appointments.tenantId, appointments.id] }).onDelete("cascade"),
  foreignKey({ name: "rating_requests_patient_fk", columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id] }).onDelete("cascade"),
  unique("rating_requests_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("rating_requests_appointment_uq").on(table.tenantId, table.appointmentId),
  uniqueIndex("rating_requests_token_hash_uq").on(table.tokenHash),
  index("rating_requests_patient_idx").on(table.tenantId, table.patientId, table.sentAt),
]);

// ---- Customer profiles (feature 27) -------------------------------------------------------------------------------

/** A free label with a colour ("VIP", "prefers mornings"). Names are unique per business, ignoring case. */
export const customerTags = pgTable("customer_tags", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 40 }).notNull(),
  /** One of a small named palette, so the screen never trusts a stored colour string. */
  color: varchar("color", { length: 12 }).notNull().default("gray"),
  createdAt: createdAt(),
}, (table) => [
  unique("customer_tags_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("customer_tags_name_uq").on(table.tenantId, sql`lower(${table.name})`),
  check("customer_tags_color_ck", sql`${table.color} in ('gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink')`),
]);

export const customerTagLinks = pgTable("customer_tag_links", {
  tenantId: text("tenant_id").notNull(),
  patientId: text("patient_id").notNull(),
  tagId: text("tag_id").notNull(),
  createdByUserId: text("created_by_user_id"),
  createdAt: createdAt(),
}, (table) => [
  primaryKey({ name: "customer_tag_links_pk", columns: [table.tenantId, table.patientId, table.tagId] }),
  foreignKey({ name: "customer_tag_links_patient_fk", columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id] }).onDelete("cascade"),
  foreignKey({ name: "customer_tag_links_tag_fk", columns: [table.tenantId, table.tagId], foreignColumns: [customerTags.tenantId, customerTags.id] }).onDelete("cascade"),
  index("customer_tag_links_tag_idx").on(table.tenantId, table.tagId),
]);

/**
 * Internal notes about a customer: attributed and dated. They are not clinical records (those stay in the protected
 * records area with their own permission). The author's name is copied so history survives a person leaving.
 */
export const customerNotes = pgTable("customer_notes", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  patientId: text("patient_id").notNull(),
  authorUserId: text("author_user_id"),
  authorName: varchar("author_name", { length: 120 }).notNull(),
  body: text("body").notNull(),
  pinned: boolean("pinned").notNull().default(false),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("customer_notes_tenant_id_id_uq").on(table.tenantId, table.id),
  foreignKey({ name: "customer_notes_patient_fk", columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id] }).onDelete("cascade"),
  index("customer_notes_patient_idx").on(table.tenantId, table.patientId, table.createdAt),
  check("customer_notes_body_ck", sql`char_length(${table.body}) between 1 and 4000`),
]);

/** A saved filter. The filter is validated JSON (see src/lib/segment-filter.ts) compiled to one parameterised query. */
export const customerSegments = pgTable("customer_segments", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 80 }).notNull(),
  filter: jsonb("filter").$type<Record<string, unknown>>().notNull(),
  createdByUserId: text("created_by_user_id"),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("customer_segments_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("customer_segments_name_uq").on(table.tenantId, sql`lower(${table.name})`),
]);

/** A field a business adds to its customers (text, number, date, one or several choices, yes or no, phone, email, link). Archived, never deleted, so old values keep a label. */
export const customerFieldDefinitions = pgTable("customer_field_definitions", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  label: varchar("label", { length: 60 }).notNull(),
  kind: varchar("kind", { length: 16 }).notNull(),
  choices: text("choices").array().notNull().default(sql`'{}'::text[]`),
  position: smallint("position").notNull().default(0),
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
}, (table) => [
  unique("customer_field_definitions_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("customer_field_definitions_label_uq").on(table.tenantId, sql`lower(${table.label})`),
  check("customer_field_definitions_kind_ck", sql`${table.kind} in ('text', 'number', 'date', 'choice', 'multichoice', 'boolean', 'phone', 'email', 'link')`),
  check("customer_field_definitions_choices_ck", sql`cardinality(${table.choices}) <= 30`),
]);

export const customerFieldValues = pgTable("customer_field_values", {
  tenantId: text("tenant_id").notNull(),
  patientId: text("patient_id").notNull(),
  fieldId: text("field_id").notNull(),
  /** Always text: a number as digits, a date as YYYY-MM-DD, several choices as a JSON list. The field's kind decides how it is read and checked. */
  value: text("value").notNull(),
  updatedByUserId: text("updated_by_user_id"),
  updatedAt: updatedAt(),
}, (table) => [
  primaryKey({ name: "customer_field_values_pk", columns: [table.tenantId, table.patientId, table.fieldId] }),
  foreignKey({ name: "customer_field_values_patient_fk", columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id] }).onDelete("cascade"),
  foreignKey({ name: "customer_field_values_field_fk", columns: [table.tenantId, table.fieldId], foreignColumns: [customerFieldDefinitions.tenantId, customerFieldDefinitions.id] }).onDelete("cascade"),
  check("customer_field_values_length_ck", sql`char_length(${table.value}) between 1 and 2500`),
]);

/**
 * One profile merged into another. The snapshot (the merged profile's own details and the ids of everything that moved,
 * sealed with the business's data key) is what lets staff undo it within 30 days; after that the snapshot is dropped.
 */
export const customerMerges = pgTable("customer_merges", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  keptPatientId: text("kept_patient_id").notNull(),
  mergedPatientId: text("merged_patient_id").notNull(),
  mergedByUserId: text("merged_by_user_id"),
  mergedAt: timestamp("merged_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  undoUntil: timestamp("undo_until", { withTimezone: true, mode: "date" }).notNull(),
  snapshotCiphertext: text("snapshot_ciphertext"),
  snapshotKeyVersion: integer("snapshot_key_version").notNull().default(0),
  undoneAt: timestamp("undone_at", { withTimezone: true, mode: "date" }),
  undoneByUserId: text("undone_by_user_id"),
}, (table) => [
  unique("customer_merges_tenant_id_id_uq").on(table.tenantId, table.id),
  foreignKey({ name: "customer_merges_kept_fk", columns: [table.tenantId, table.keptPatientId], foreignColumns: [patients.tenantId, patients.id] }).onDelete("restrict"),
  foreignKey({ name: "customer_merges_merged_fk", columns: [table.tenantId, table.mergedPatientId], foreignColumns: [patients.tenantId, patients.id] }).onDelete("restrict"),
  check("customer_merges_distinct_ck", sql`${table.keptPatientId} <> ${table.mergedPatientId}`),
  uniqueIndex("customer_merges_active_uq").on(table.tenantId, table.mergedPatientId).where(sql`${table.undoneAt} is null`),
  index("customer_merges_kept_idx").on(table.tenantId, table.keptPatientId, table.mergedAt),
]);


// ---- Campaigns and win-back (feature 28) ---------------------------------------------------------------------------

/**
 * One campaign. An automated one runs once a day against a rule and catches each customer once as they qualify (recall
 * after a service's interval, birthday, win-back, package about to expire). A one-off one sends once to a segment's
 * customers. Marketing needs its own consent: who is included is decided at send time by src/server/campaigns/audience.ts.
 */
export const campaigns = pgTable("campaigns", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  kind: varchar("kind", { length: 10 }).notNull(),
  /** Automated only: recall, birthday, win_back or package_expiring. */
  ruleType: varchar("rule_type", { length: 20 }),
  /** The rule's numbers (days since the service, days away, days before expiry) and the service it is about. Validated on write. */
  rule: jsonb("rule").$type<Record<string, unknown>>().notNull().default({}),
  /** The ready-made campaign this one was switched on from ("recall_6_months"), so a preset is not offered twice. */
  presetKey: varchar("preset_key", { length: 40 }),
  /** One-off only. The filter is copied here when the campaign is made, so editing or deleting the segment never changes a campaign already set up. */
  segmentId: text("segment_id"),
  segmentFilter: jsonb("segment_filter").$type<Record<string, unknown>>(),
  channel: varchar("channel", { length: 10 }).notNull(),
  subject: varchar("subject", { length: 200 }),
  /** The owner's words for email and text. Filled in per customer with the same {{name}} style fields workflows use. */
  body: text("body"),
  /** WhatsApp: the key of an approved marketing template in message_templates. Nothing else is ever sent on WhatsApp. */
  templateKey: varchar("template_key", { length: 60 }),
  /** The service the campaign is about: a customer with a booking coming up for it is never messaged. */
  serviceId: text("service_id"),
  status: varchar("status", { length: 12 }).notNull().default("draft"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: "date" }),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  /** The business-local day an automated campaign last ran for, so a restart the same day does not run it twice. */
  lastRunOn: date("last_run_on", { mode: "string" }),
  /** Why a campaign stopped by itself: high_unsubscribes or high_failures. Empty when the owner paused it. */
  pausedReason: varchar("paused_reason", { length: 24 }),
  /** The version the owner last sent a test of. Changing the words or channel raises `version`, so a new test is needed before it can go out. */
  testedVersion: integer("tested_version"),
  testedAt: timestamp("tested_at", { withTimezone: true, mode: "date" }),
  /** In booking links as utm_campaign, so a booking made from a message is credited to the campaign. */
  code: varchar("code", { length: 24 }).notNull(),
  version: integer("version").notNull().default(1),
  createdByUserId: text("created_by_user_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("campaigns_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("campaigns_code_uq").on(table.tenantId, table.code),
  uniqueIndex("campaigns_preset_uq").on(table.tenantId, table.presetKey).where(sql`${table.presetKey} is not null`),
  index("campaigns_status_idx").on(table.tenantId, table.status),
  check("campaigns_kind_ck", sql`${table.kind} in ('automated', 'one_off')`),
  check("campaigns_channel_ck", sql`${table.channel} in ('email', 'whatsapp', 'sms')`),
  check("campaigns_status_ck", sql`${table.status} in ('draft', 'active', 'paused', 'sending', 'completed', 'cancelled')`),
  check("campaigns_rule_ck", sql`(${table.kind} = 'automated') = (${table.ruleType} is not null) and (${table.ruleType} is null or ${table.ruleType} in ('recall', 'birthday', 'win_back', 'package_expiring', 'routing_abandoned'))`),
]);

/**
 * One row per customer per campaign. The unique key is what makes a restart safe: a second fan-out finds the row and
 * adds nothing, and a send in progress is claimed by changing the row's status, never by re-reading the audience.
 */
export const campaignSends = pgTable("campaign_sends", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  campaignId: text("campaign_id").notNull(),
  patientId: text("patient_id").notNull(),
  /** What makes a second row for the same customer legitimate: the year for a birthday message, a package's id for an expiry notice. Empty for everything else, so a customer is caught once per campaign. */
  cycle: varchar("cycle", { length: 40 }).notNull().default(""),
  channel: varchar("channel", { length: 10 }).notNull(),
  /** pending (waiting for its turn), queued (with the worker), sent, failed or skipped (with `reason`). */
  status: varchar("status", { length: 10 }).notNull().default("pending"),
  reason: varchar("reason", { length: 40 }),
  sendAt: timestamp("send_at", { withTimezone: true, mode: "date" }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
  /** SHA-256 of the 256-bit token in this message's unsubscribe link. The token itself is never stored. */
  unsubscribeTokenHash: varchar("unsubscribe_token_hash", { length: 64 }).notNull(),
  /** The same token sealed, so a retried send builds the same link. Opened only by the worker. */
  unsubscribeTokenCiphertext: text("unsubscribe_token_ciphertext"),
  unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true, mode: "date" }),
  /** The first booking this customer made through the campaign's link within 7 days of the message. */
  bookedAppointmentId: text("booked_appointment_id"),
  bookedAt: timestamp("booked_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({ name: "campaign_sends_campaign_fk", columns: [table.tenantId, table.campaignId], foreignColumns: [campaigns.tenantId, campaigns.id] }).onDelete("cascade"),
  foreignKey({ name: "campaign_sends_patient_fk", columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id] }).onDelete("cascade"),
  unique("campaign_sends_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("campaign_sends_customer_uq").on(table.tenantId, table.campaignId, table.patientId, table.cycle),
  uniqueIndex("campaign_sends_token_uq").on(table.unsubscribeTokenHash),
  index("campaign_sends_due_idx").on(table.sendAt).where(sql`${table.status} = 'pending'`),
  index("campaign_sends_patient_idx").on(table.tenantId, table.patientId, table.sentAt),
  index("campaign_sends_campaign_idx").on(table.tenantId, table.campaignId, table.status),
  check("campaign_sends_status_ck", sql`${table.status} in ('pending', 'queued', 'sent', 'failed', 'skipped')`),
]);

/** A customer's choice about marketing on one channel, with when and how it changed. Saying the same thing again changes nothing. */
export const marketingPreferences = pgTable("marketing_preferences", {
  tenantId: text("tenant_id").notNull(),
  patientId: text("patient_id").notNull(),
  channel: varchar("channel", { length: 10 }).notNull(),
  optedIn: boolean("opted_in").notNull(),
  source: varchar("source", { length: 20 }).notNull(),
  changedAt: timestamp("changed_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: "marketing_preferences_pk", columns: [table.tenantId, table.patientId, table.channel] }),
  foreignKey({ name: "marketing_preferences_patient_fk", columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id] }).onDelete("cascade"),
  check("marketing_preferences_channel_ck", sql`${table.channel} in ('email', 'whatsapp', 'sms')`),
]);

/**
 * An app a business has installed from the Apps page (feature 55). The registry of apps is code; this row only records
 * that this business turned one on. Credentials (a Slack token, a HubSpot token) are sealed with the business's data key
 * and never read back by any screen. One row per business per app; uninstalling removes it after the worker has revoked
 * the credential at the provider, so a row in `uninstalling` is a removal in progress.
 */
export const appInstalls = pgTable("app_installs", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  appKey: varchar("app_key", { length: 40 }).notNull(),
  /** active, paused (owner switched it off), failing (switched off after repeated failures) or uninstalling. */
  status: varchar("status", { length: 16 }).notNull().default("active"),
  /** Validated against the app's own schema on every write. Holds choices (a channel, a field map), never secrets. */
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  credentialsCiphertext: text("credentials_ciphertext"),
  keyVersion: integer("key_version"),
  installedByUserId: text("installed_by_user_id"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  disabledReason: varchar("disabled_reason", { length: 32 }),
  version: integer("version").notNull().default(1),
  installedAt: timestamp("installed_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("app_installs_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("app_installs_tenant_app_uq").on(table.tenantId, table.appKey),
  check("app_installs_status_ck", sql`${table.status} in ('active', 'paused', 'failing', 'uninstalling')`),
  check("app_installs_key_ck", sql`${table.appKey} ~ '^[a-z][a-z0-9-]{1,39}$'`),
  check("app_installs_credentials_ck", sql`(${table.credentialsCiphertext} is null) = (${table.keyVersion} is null)`),
  index("app_installs_active_idx").on(table.tenantId, table.status),
]);

/**
 * What an installed app did: one row per event it handled or was asked to handle. Fixed codes only. It never holds a
 * customer's details, the message text or what the provider replied. It outlives the install so an owner can see that
 * an app was removed.
 */
export const appEvents = pgTable("app_events", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  appKey: varchar("app_key", { length: 40 }).notNull(),
  /** A public event name such as appointment.created, or install, uninstall, test, settings. */
  eventType: varchar("event_type", { length: 40 }).notNull(),
  /** delivered, failed or skipped. */
  outcome: varchar("outcome", { length: 12 }).notNull(),
  errorCode: varchar("error_code", { length: 40 }),
  createdAt: createdAt(),
}, (table) => [
  unique("app_events_tenant_id_id_uq").on(table.tenantId, table.id),
  check("app_events_outcome_ck", sql`${table.outcome} in ('delivered', 'failed', 'skipped')`),
  index("app_events_app_idx").on(table.tenantId, table.appKey, table.createdAt),
]);

/**
 * An app a business registered for its own software (feature 55). It signs in with OAuth 2 and may ask for any of the
 * API scopes listed here. The secret is shown once; only its SHA-256 hash is kept. First-party clients, such as the
 * browser extension, live in code and have no row.
 */
export const oauthClients = pgTable("oauth_clients", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 60 }).notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  /** The most this app may ask for. A grant can hold fewer, never more. */
  scopes: text("scopes").array().notNull(),
  secretHash: varchar("secret_hash", { length: 64 }).notNull(),
  secretPrefix: varchar("secret_prefix", { length: 16 }).notNull(),
  createdByUserId: text("created_by_user_id"),
  createdAt: createdAt(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  unique("oauth_clients_tenant_id_id_uq").on(table.tenantId, table.id),
  check("oauth_clients_redirects_ck", sql`cardinality(${table.redirectUris}) between 1 and 5`),
  check("oauth_clients_scopes_ck", sql`cardinality(${table.scopes}) between 1 and 20`),
  index("oauth_clients_list_idx").on(table.tenantId, table.createdAt),
]);

/**
 * One person's approval of one app for one business. Revoking it stops every token under it at once. `clientKind` is
 * `builtin` for our own clients (the extension) and `custom` for a row in oauth_clients.
 */
export const oauthGrants = pgTable("oauth_grants", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  clientKind: varchar("client_kind", { length: 8 }).notNull(),
  clientId: varchar("client_id", { length: 64 }).notNull(),
  /** The app's name as the person saw it when they approved. */
  clientName: varchar("client_name", { length: 60 }).notNull(),
  userId: text("user_id").notNull(),
  scopes: text("scopes").array().notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  unique("oauth_grants_tenant_id_id_uq").on(table.tenantId, table.id),
  check("oauth_grants_kind_ck", sql`${table.clientKind} in ('builtin', 'custom')`),
  check("oauth_grants_scopes_ck", sql`cardinality(${table.scopes}) between 1 and 20`),
  index("oauth_grants_list_idx").on(table.tenantId, table.createdAt),
]);

/** A one-use code that the app trades for tokens. Lives ten minutes. Only its hash is kept. */
export const oauthCodes = pgTable("oauth_codes", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  grantId: text("grant_id").notNull(),
  codeHash: varchar("code_hash", { length: 64 }).notNull(),
  /** PKCE: the S256 challenge the app sent. Every client must use it. */
  codeChallenge: varchar("code_challenge", { length: 43 }).notNull(),
  redirectUri: varchar("redirect_uri", { length: 600 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
}, (table) => [
  unique("oauth_codes_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("oauth_codes_hash_uq").on(table.codeHash),
  foreignKey({ name: "oauth_codes_grant_fk", columns: [table.tenantId, table.grantId], foreignColumns: [oauthGrants.tenantId, oauthGrants.id] }).onDelete("cascade"),
  index("oauth_codes_grant_idx").on(table.tenantId, table.grantId),
]);

/**
 * Access and refresh tokens. An access token (`kat_`) lasts an hour and works like an API key limited to the grant's
 * scopes; a refresh token (`krt_`) lasts 60 days and is swapped for a new pair each time it is used. Using one twice
 * means it leaked, and the whole grant is revoked. Only hashes are kept.
 */
export const oauthTokens = pgTable("oauth_tokens", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  grantId: text("grant_id").notNull(),
  kind: varchar("kind", { length: 8 }).notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
}, (table) => [
  unique("oauth_tokens_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("oauth_tokens_hash_uq").on(table.tokenHash),
  check("oauth_tokens_kind_ck", sql`${table.kind} in ('access', 'refresh')`),
  foreignKey({ name: "oauth_tokens_grant_fk", columns: [table.tenantId, table.grantId], foreignColumns: [oauthGrants.tenantId, oauthGrants.id] }).onDelete("cascade"),
  index("oauth_tokens_grant_idx").on(table.tenantId, table.grantId),
]);

/**
 * A device sign-in in progress (feature 57, RFC 8628): the browser extension asks for a code, shows it to the person, and
 * the person types it on their signed-in Kalendr page. The request comes from a browser that has no business yet, so these
 * rows have none until someone approves: that is why the table sits behind a deny-all policy and is reached only through
 * the kalendr_device_* functions. Both codes are stored as hashes and the row is deleted soon after use.
 */
export const oauthDeviceCodes = pgTable("oauth_device_codes", {
  id: id(),
  deviceHash: varchar("device_hash", { length: 64 }).notNull(),
  userCodeHash: varchar("user_code_hash", { length: 64 }).notNull(),
  clientId: varchar("client_id", { length: 64 }).notNull(),
  scopes: text("scopes").array().notNull(),
  /** pending, approved (a person said yes), denied, or used (the extension collected its tokens). */
  status: varchar("status", { length: 10 }).notNull().default("pending"),
  tenantId: text("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
  grantId: text("grant_id"),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true, mode: "date" }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("oauth_device_codes_device_uq").on(table.deviceHash),
  uniqueIndex("oauth_device_codes_user_uq").on(table.userCodeHash),
  check("oauth_device_codes_status_ck", sql`${table.status} in ('pending', 'approved', 'denied', 'used')`),
  check("oauth_device_codes_approved_ck", sql`${table.status} not in ('approved', 'used') or (${table.tenantId} is not null and ${table.grantId} is not null)`),
  index("oauth_device_codes_expiry_idx").on(table.expiresAt),
]);

/**
 * A routing form (feature 46): a few questions, then the right service and person. The row holds the form the owner is
 * editing; each publish copies it into `routing_form_versions`, which customers see and which never changes. `revision`
 * is the edit counter used to catch two people saving at once; `live_version` is the published version customers get.
 */
export const routingForms = pgTable("routing_forms", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  /** Stays the same for the life of the form. */
  key: text("key").notNull().default(sql`gen_random_uuid()::text`),
  name: varchar("name", { length: 120 }).notNull(),
  slug: varchar("slug", { length: 60 }).notNull(),
  intro: varchar("intro", { length: 300 }).notNull().default(""),
  /** The questions, routes and fallback being edited. Checked by the routing-forms schema before it is stored. */
  definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
  status: varchar("status", { length: 8 }).notNull().default("draft"),
  revision: integer("revision").notNull().default(1),
  liveVersion: integer("live_version"),
  createdByUserId: text("created_by_user_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("routing_forms_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("routing_forms_tenant_slug_uq").on(table.tenantId, table.slug),
  check("routing_forms_status_ck", sql`${table.status} in ('draft', 'live')`),
  check("routing_forms_live_ck", sql`${table.status} <> 'live' or ${table.liveVersion} is not null`),
]);

/** One published version of a form. Responses point at the version they were answered with. */
export const routingFormVersions = pgTable("routing_form_versions", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  formId: text("form_id").notNull(),
  version: integer("version").notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  intro: varchar("intro", { length: 300 }).notNull().default(""),
  definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
  publishedByUserId: text("published_by_user_id"),
  createdAt: createdAt(),
}, (table) => [
  unique("routing_form_versions_tenant_id_id_uq").on(table.tenantId, table.id),
  unique("routing_form_versions_form_version_uq").on(table.tenantId, table.formId, table.version),
  foreignKey({ name: "routing_form_versions_form_fk", columns: [table.tenantId, table.formId], foreignColumns: [routingForms.tenantId, routingForms.id] }).onDelete("cascade"),
  check("routing_form_versions_version_ck", sql`${table.version} >= 1`),
]);

/**
 * One visit to a form. The row is made when the form opens (the funnel's first step), filled when it is answered, and
 * linked to the booking when one is made. The answers are sealed with the business's key. The token is 256 bits and only
 * its hash is stored; it lets the booking page prefill the booking and limits who can be offered, so the browser never
 * sends people or weights itself.
 */
export const routingResponses = pgTable("routing_responses", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  formId: text("form_id").notNull(),
  formVersion: integer("form_version").notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  answersCiphertext: text("answers_ciphertext"),
  keyVersion: integer("key_version").notNull().default(0),
  routeId: varchar("route_id", { length: 80 }),
  routeName: varchar("route_name", { length: 120 }),
  destinationType: varchar("destination_type", { length: 8 }),
  serviceId: text("service_id"),
  /** Everyone who may be offered, and how much extra weight each carries. Server-side only. */
  candidateIds: text("candidate_ids").array().notNull().default(sql`'{}'::text[]`),
  multipliers: jsonb("multipliers").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
  /** Which routes matched and why. Holds the owner's own rule text and choices only, never a typed answer. */
  trace: jsonb("trace").$type<Record<string, unknown>>(),
  /** "pending" until the customer books (or is sent away or shown a message). */
  outcome: varchar("outcome", { length: 10 }).notNull().default("pending"),
  appointmentId: text("appointment_id"),
  /** Set when the answers included an email that belongs to a customer, for follow-ups that respect consent. */
  patientId: text("patient_id"),
  openedAt: timestamp("opened_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  answeredAt: timestamp("answered_at", { withTimezone: true, mode: "date" }),
  slotShownAt: timestamp("slot_shown_at", { withTimezone: true, mode: "date" }),
  bookedAt: timestamp("booked_at", { withTimezone: true, mode: "date" }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  unique("routing_responses_tenant_id_id_uq").on(table.tenantId, table.id),
  uniqueIndex("routing_responses_token_uq").on(table.tokenHash),
  uniqueIndex("routing_responses_appointment_uq").on(table.tenantId, table.appointmentId).where(sql`${table.appointmentId} is not null`),
  index("routing_responses_form_idx").on(table.tenantId, table.formId, table.openedAt),
  foreignKey({ name: "routing_responses_form_fk", columns: [table.tenantId, table.formId], foreignColumns: [routingForms.tenantId, routingForms.id] }).onDelete("cascade"),
  foreignKey({ name: "routing_responses_appointment_fk", columns: [table.tenantId, table.appointmentId], foreignColumns: [appointments.tenantId, appointments.id] }),
  check("routing_responses_outcome_ck", sql`${table.outcome} in ('pending', 'booked', 'external', 'message')`),
  check("routing_responses_destination_ck", sql`${table.destinationType} is null or ${table.destinationType} in ('service', 'external', 'message')`),
  check("routing_responses_booked_ck", sql`${table.outcome} <> 'booked' or ${table.appointmentId} is not null`),
]);

/** "This booking should have gone to Dr Shah." Staff report it; an admin reviews and uses the list to fix the routes. */
export const wrongAssignmentReports = pgTable("wrong_assignment_reports", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  appointmentId: text("appointment_id").notNull(),
  reportedByUserId: text("reported_by_user_id").notNull(),
  correctPractitionerId: text("correct_practitioner_id"),
  noteCiphertext: text("note_ciphertext"),
  keyVersion: integer("key_version").notNull().default(0),
  status: varchar("status", { length: 10 }).notNull().default("open"),
  version: integer("version").notNull().default(1),
  reviewedByUserId: text("reviewed_by_user_id"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "date" }),
  createdAt: createdAt(),
}, (table) => [
  unique("wrong_assignment_reports_tenant_id_id_uq").on(table.tenantId, table.id),
  index("wrong_assignment_reports_status_idx").on(table.tenantId, table.status, table.createdAt),
  foreignKey({ name: "wrong_assignment_reports_tenant_fk", columns: [table.tenantId], foreignColumns: [tenants.id] }).onDelete("cascade"),
  foreignKey({ name: "wrong_assignment_reports_appointment_fk", columns: [table.tenantId, table.appointmentId], foreignColumns: [appointments.tenantId, appointments.id] }),
  foreignKey({ name: "wrong_assignment_reports_practitioner_fk", columns: [table.tenantId, table.correctPractitionerId], foreignColumns: [practitioners.tenantId, practitioners.id] }),
  check("wrong_assignment_reports_status_ck", sql`${table.status} in ('open', 'fixed', 'dismissed')`),
]);
