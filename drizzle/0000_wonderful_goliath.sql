CREATE EXTENSION IF NOT EXISTS "btree_gist";--> statement-breakpoint
CREATE TYPE "public"."appointment_status" AS ENUM('requested', 'booked', 'checked_in', 'completed', 'cancelled', 'no_show', 'entered_in_error');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('success', 'denied', 'failed');--> statement-breakpoint
CREATE TYPE "public"."booking_mode" AS ENUM('instant', 'request');--> statement-breakpoint
CREATE TYPE "public"."booking_source" AS ENUM('online', 'staff', 'widget', 'recall', 'waitlist');--> statement-breakpoint
CREATE TYPE "public"."confirmation_status" AS ENUM('needs_action', 'confirmed', 'declined');--> statement-breakpoint
CREATE TYPE "public"."contact_channel" AS ENUM('sms', 'email', 'whatsapp', 'phone');--> statement-breakpoint
CREATE TYPE "public"."domain_status" AS ENUM('pending', 'verified', 'active', 'failed');--> statement-breakpoint
CREATE TYPE "public"."form_status" AS ENUM('not_assigned', 'not_started', 'in_progress', 'submitted');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'admin', 'receptionist', 'practitioner', 'billing', 'read_only');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('queued', 'sending', 'delivered', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'processing', 'delivered', 'failed', 'dead_letter');--> statement-breakpoint
CREATE TYPE "public"."recall_status" AS ENUM('upcoming', 'due', 'overdue', 'contacted', 'snoozed', 'booked', 'closed');--> statement-breakpoint
CREATE TYPE "public"."reminder_status" AS ENUM('not_scheduled', 'queued', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."reservation_state" AS ENUM('held', 'confirmed', 'released');--> statement-breakpoint
CREATE TYPE "public"."resource_kind" AS ENUM('operatory', 'room', 'chair', 'equipment');--> statement-breakpoint
CREATE TYPE "public"."waitlist_status" AS ENUM('active', 'offered', 'fulfilled', 'expired', 'declined');--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"location_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"practitioner_id" text NOT NULL,
	"service_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "appointment_status" NOT NULL,
	"confirmation_status" "confirmation_status" DEFAULT 'needs_action' NOT NULL,
	"booking_source" "booking_source" NOT NULL,
	"form_status" "form_status" DEFAULT 'not_assigned' NOT NULL,
	"reminder_status" "reminder_status" DEFAULT 'not_scheduled' NOT NULL,
	"manage_token_hash" varchar(64) NOT NULL,
	"notes" text,
	"version" integer DEFAULT 1 NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "appointments_time_order_check" CHECK ("appointments"."ends_at" > "appointments"."starts_at"),
	CONSTRAINT "appointments_version_positive" CHECK ("appointments"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"appointment_id" text,
	"actor_user_id" text,
	"actor_type" varchar(40) NOT NULL,
	"action" varchar(160) NOT NULL,
	"outcome" "audit_outcome" NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "auth_accounts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"issuer" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_accounts_issuer_account_uq" UNIQUE("issuer","account_id")
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_users" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"name" text NOT NULL,
	"email" varchar(254) NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_verifications" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "availability_rules" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"location_id" text NOT NULL,
	"practitioner_id" text NOT NULL,
	"day_of_week" smallint NOT NULL,
	"starts_at_local" time NOT NULL,
	"ends_at_local" time NOT NULL,
	"timezone" varchar(64) NOT NULL,
	"valid_from" date NOT NULL,
	"valid_through" date,
	"slot_interval_minutes" smallint DEFAULT 15 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_rules_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "availability_rules_day_of_week_check" CHECK ("availability_rules"."day_of_week" between 1 and 7),
	CONSTRAINT "availability_rules_time_order_check" CHECK ("availability_rules"."ends_at_local" > "availability_rules"."starts_at_local")
);
--> statement-breakpoint
CREATE TABLE "forms" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"definition_key" varchar(120) NOT NULL,
	"definition_version" integer NOT NULL,
	"status" "form_status" DEFAULT 'not_started' NOT NULL,
	"response_ciphertext" text,
	"encryption_key_version" varchar(80),
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forms_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "forms_appointment_definition_uq" UNIQUE("tenant_id","appointment_id","definition_key")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"route" varchar(160) NOT NULL,
	"key" varchar(160) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"response_status" smallint,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	CONSTRAINT "idempotency_keys_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "idempotency_keys_route_key_uq" UNIQUE("tenant_id","route","key")
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"name" varchar(160) NOT NULL,
	"address" text NOT NULL,
	"city" varchar(120) NOT NULL,
	"timezone" varchar(64) NOT NULL,
	"accessible_entrance" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locations_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "membership_role" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_tenant_user_uq" UNIQUE("tenant_id","user_id"),
	CONSTRAINT "memberships_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"appointment_id" text,
	"channel" "contact_channel" NOT NULL,
	"template_key" varchar(120) NOT NULL,
	"destination_ciphertext" text NOT NULL,
	"provider_message_id" text,
	"semantic_key" varchar(200) NOT NULL,
	"status" "notification_status" DEFAULT 'queued' NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_code" varchar(120),
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "notifications_semantic_key_uq" UNIQUE("tenant_id","semantic_key")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"aggregate_type" varchar(80) NOT NULL,
	"aggregate_id" text NOT NULL,
	"event_type" varchar(120) NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" varchar(200) NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" varchar(120),
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"last_error_code" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "outbox_events_dedupe_key_uq" UNIQUE("tenant_id","dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"first_name" varchar(80) NOT NULL,
	"last_name" varchar(80) NOT NULL,
	"phone" varchar(32) NOT NULL,
	"email" varchar(254) NOT NULL,
	"date_of_birth" date,
	"preferred_channel" "contact_channel" NOT NULL,
	"accessibility_need" text,
	"is_dependent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patients_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "practitioner_locations" (
	"tenant_id" text NOT NULL,
	"practitioner_id" text NOT NULL,
	"location_id" text NOT NULL,
	CONSTRAINT "practitioner_locations_pk" PRIMARY KEY("tenant_id","practitioner_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "practitioner_services" (
	"tenant_id" text NOT NULL,
	"practitioner_id" text NOT NULL,
	"service_id" text NOT NULL,
	CONSTRAINT "practitioner_services_pk" PRIMARY KEY("tenant_id","practitioner_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "practitioners" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"auth_user_id" text,
	"name" varchar(160) NOT NULL,
	"title" varchar(120) NOT NULL,
	"initials" varchar(12) NOT NULL,
	"specialty" varchar(160) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practitioners_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "recalls" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"service_id" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" "recall_status" DEFAULT 'upcoming' NOT NULL,
	"last_contacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recalls_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "resource_reservations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"practitioner_id" text,
	"resource_id" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"state" "reservation_state" NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_reservations_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "resource_reservations_subject_check" CHECK (num_nonnulls("resource_reservations"."practitioner_id", "resource_reservations"."resource_id") = 1),
	CONSTRAINT "resource_reservations_time_order_check" CHECK ("resource_reservations"."ends_at" > "resource_reservations"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"location_id" text NOT NULL,
	"name" varchar(160) NOT NULL,
	"kind" "resource_kind" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "service_locations" (
	"tenant_id" text NOT NULL,
	"service_id" text NOT NULL,
	"location_id" text NOT NULL,
	CONSTRAINT "service_locations_pk" PRIMARY KEY("tenant_id","service_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"name" varchar(160) NOT NULL,
	"description" text NOT NULL,
	"duration_minutes" smallint NOT NULL,
	"buffer_before_minutes" smallint DEFAULT 0 NOT NULL,
	"buffer_after_minutes" smallint DEFAULT 0 NOT NULL,
	"slot_interval_minutes" smallint DEFAULT 15 NOT NULL,
	"minimum_lead_minutes" integer DEFAULT 60 NOT NULL,
	"maximum_advance_days" smallint DEFAULT 90 NOT NULL,
	"booking_mode" "booking_mode" NOT NULL,
	"patient_types" text[] NOT NULL,
	"required_resource_kind" "resource_kind",
	"price_label" varchar(80),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "services_duration_positive" CHECK ("services"."duration_minutes" > 0),
	CONSTRAINT "services_slot_interval_positive" CHECK ("services"."slot_interval_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "tenant_domains" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"hostname" varchar(253) NOT NULL,
	"status" "domain_status" DEFAULT 'pending' NOT NULL,
	"verification_token_hash" varchar(64),
	"verified_at" timestamp with time zone,
	"certificate_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_domains_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"slug" varchar(80) NOT NULL,
	"name" varchar(160) NOT NULL,
	"legal_name" varchar(200) NOT NULL,
	"phone" varchar(32) NOT NULL,
	"email" varchar(254) NOT NULL,
	"timezone" varchar(64) NOT NULL,
	"locale" varchar(32) DEFAULT 'en-IN' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waitlist_entries" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"service_id" text NOT NULL,
	"location_id" text NOT NULL,
	"preferred_practitioner_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"date_from" date NOT NULL,
	"date_to" date NOT NULL,
	"time_preference" varchar(24) NOT NULL,
	"status" "waitlist_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_entries_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "waitlist_entries_date_order_check" CHECK ("waitlist_entries"."date_to" >= "waitlist_entries"."date_from")
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_practitioner_fk" FOREIGN KEY ("tenant_id","practitioner_id") REFERENCES "public"."practitioners"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_practitioner_fk" FOREIGN KEY ("tenant_id","practitioner_id") REFERENCES "public"."practitioners"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner_locations" ADD CONSTRAINT "practitioner_locations_practitioner_fk" FOREIGN KEY ("tenant_id","practitioner_id") REFERENCES "public"."practitioners"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner_locations" ADD CONSTRAINT "practitioner_locations_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner_services" ADD CONSTRAINT "practitioner_services_practitioner_fk" FOREIGN KEY ("tenant_id","practitioner_id") REFERENCES "public"."practitioners"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner_services" ADD CONSTRAINT "practitioner_services_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioners" ADD CONSTRAINT "practitioners_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioners" ADD CONSTRAINT "practitioners_auth_user_id_auth_users_id_fk" FOREIGN KEY ("auth_user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_reservations" ADD CONSTRAINT "resource_reservations_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_reservations" ADD CONSTRAINT "resource_reservations_practitioner_fk" FOREIGN KEY ("tenant_id","practitioner_id") REFERENCES "public"."practitioners"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_reservations" ADD CONSTRAINT "resource_reservations_resource_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."resources"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_tenant_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_locations" ADD CONSTRAINT "service_locations_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_locations" ADD CONSTRAINT "service_locations_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_manage_token_hash_uq" ON "appointments" USING btree ("manage_token_hash");--> statement-breakpoint
CREATE INDEX "appointments_dayboard_idx" ON "appointments" USING btree ("tenant_id","location_id","starts_at");--> statement-breakpoint
CREATE INDEX "audit_events_timeline_idx" ON "audit_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "auth_accounts_user_idx" ON "auth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_uq" ON "auth_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_users_email_uq" ON "auth_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier_idx" ON "auth_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "availability_rules_lookup_idx" ON "availability_rules" USING btree ("tenant_id","location_id","practitioner_id","day_of_week");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expiry_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "locations_tenant_idx" ON "locations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_due_idx" ON "notifications" USING btree ("tenant_id","status","scheduled_at");--> statement-breakpoint
CREATE INDEX "outbox_events_claim_idx" ON "outbox_events" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "patients_tenant_name_idx" ON "patients" USING btree ("tenant_id","last_name","first_name");--> statement-breakpoint
CREATE INDEX "practitioners_tenant_idx" ON "practitioners" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "recalls_due_idx" ON "recalls" USING btree ("tenant_id","status","due_at");--> statement-breakpoint
CREATE INDEX "resource_reservations_appointment_idx" ON "resource_reservations" USING btree ("tenant_id","appointment_id");--> statement-breakpoint
CREATE INDEX "resources_location_kind_idx" ON "resources" USING btree ("tenant_id","location_id","kind");--> statement-breakpoint
CREATE INDEX "services_tenant_idx" ON "services" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_domains_hostname_uq" ON "tenant_domains" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "tenant_domains_tenant_idx" ON "tenant_domains" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_uq" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "waitlist_entries_active_idx" ON "waitlist_entries" USING btree ("tenant_id","status");--> statement-breakpoint

-- A booking owns one practitioner reservation and, when required, one physical
-- resource reservation. The database remains authoritative even when two app
-- instances race after observing the same available slot.
ALTER TABLE "resource_reservations"
  ADD CONSTRAINT "resource_reservations_no_practitioner_overlap"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "practitioner_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  )
  WHERE (
    "practitioner_id" IS NOT NULL
    AND "state" IN ('held', 'confirmed')
  );--> statement-breakpoint

ALTER TABLE "resource_reservations"
  ADD CONSTRAINT "resource_reservations_no_resource_overlap"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "resource_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  )
  WHERE (
    "resource_id" IS NOT NULL
    AND "state" IN ('held', 'confirmed')
  );--> statement-breakpoint

-- The runtime role must be a non-owner without BYPASSRLS. Every request sets
-- app.tenant_id inside a transaction before touching tenant-owned rows.
DO $nira_rls$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'tenant_domains',
    'memberships',
    'locations',
    'patients',
    'services',
    'practitioners',
    'resources',
    'practitioner_locations',
    'practitioner_services',
    'service_locations',
    'availability_rules',
    'appointments',
    'resource_reservations',
    'waitlist_entries',
    'recalls',
    'forms',
    'notifications',
    'outbox_events',
    'audit_events',
    'idempotency_keys'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), ''''))',
      tenant_table
    );
  END LOOP;
END
$nira_rls$;--> statement-breakpoint

ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenants"
  FOR ALL
  USING ("id" = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint

-- These narrowly-scoped resolvers bootstrap the tenant context without giving
-- the runtime role unrestricted reads across tenant tables. Keep ownership on
-- the privileged migration role and grant EXECUTE only to the runtime role.
CREATE OR REPLACE FUNCTION "nira_resolve_tenant"(
  p_slug text,
  p_hostname text DEFAULT NULL
)
RETURNS TABLE (
  tenant_id text,
  slug text,
  name text,
  legal_name text,
  phone text,
  email text,
  timezone text,
  locale text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $nira_resolve_tenant$
  SELECT
    tenant.id,
    tenant.slug::text,
    tenant.name::text,
    tenant.legal_name::text,
    tenant.phone::text,
    tenant.email::text,
    tenant.timezone::text,
    tenant.locale::text
  FROM tenants AS tenant
  WHERE tenant.is_active
    AND (
      (p_slug IS NOT NULL AND tenant.slug = lower(p_slug))
      OR (
        p_hostname IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM tenant_domains AS domain
          WHERE domain.tenant_id = tenant.id
            AND domain.hostname = lower(p_hostname)
            AND domain.status = 'active'
        )
      )
    )
  ORDER BY tenant.id
  LIMIT 1
$nira_resolve_tenant$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "nira_resolve_manage_token"(p_token_hash text)
RETURNS TABLE (tenant_id text, appointment_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $nira_resolve_manage_token$
  SELECT appointment.tenant_id, appointment.id
  FROM appointments AS appointment
  WHERE appointment.manage_token_hash = p_token_hash
  LIMIT 1
$nira_resolve_manage_token$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "nira_resolve_staff_appointment"(
  p_user_id text,
  p_appointment_id text
)
RETURNS TABLE (tenant_id text, appointment_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $nira_resolve_staff_appointment$
  SELECT appointment.tenant_id, appointment.id
  FROM appointments AS appointment
  JOIN memberships AS membership
    ON membership.tenant_id = appointment.tenant_id
   AND membership.user_id = p_user_id
   AND membership.is_active
  LEFT JOIN practitioners AS practitioner
    ON practitioner.tenant_id = appointment.tenant_id
   AND practitioner.id = appointment.practitioner_id
  WHERE appointment.id = p_appointment_id
    AND (
      membership.role IN ('owner', 'admin', 'receptionist')
      OR (
        membership.role = 'practitioner'
        AND practitioner.auth_user_id = p_user_id
      )
    )
  LIMIT 1
$nira_resolve_staff_appointment$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "nira_resolve_tenant"(text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "nira_resolve_manage_token"(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "nira_resolve_staff_appointment"(text, text) FROM PUBLIC;--> statement-breakpoint
