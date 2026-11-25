CREATE TYPE "public"."consent_purpose" AS ENUM('appointment_messages', 'marketing_messages', 'reviews', 'records_sharing');--> statement-breakpoint
CREATE TYPE "public"."consent_source" AS ENUM('booking', 'portal', 'staff', 'whatsapp_stop', 'sms_stop', 'import', 'system');--> statement-breakpoint
CREATE TYPE "public"."data_request_status" AS ENUM('requested', 'approved', 'refused', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."data_request_type" AS ENUM('export', 'erasure', 'correction');--> statement-breakpoint
CREATE TYPE "public"."retention_action" AS ENUM('delete', 'anonymise');--> statement-breakpoint
CREATE TYPE "public"."retention_kind" AS ENUM('login_codes', 'message_log', 'cancelled_booking_details', 'finished_outbox', 'medical_records', 'billing_records');--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"purpose" "consent_purpose" NOT NULL,
	"granted" boolean NOT NULL,
	"wording_version" varchar(40) NOT NULL,
	"source" "consent_source" NOT NULL,
	"actor_type" varchar(20) NOT NULL,
	"actor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_records_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "consent_records_actor_valid" CHECK ("consent_records"."actor_type" in ('patient', 'guardian', 'staff', 'system', 'provider'))
);
--> statement-breakpoint
CREATE TABLE "data_exports" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"request_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"key_version" integer DEFAULT 0 NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_exports_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "data_exports_request_uq" UNIQUE("tenant_id","request_id"),
	CONSTRAINT "data_exports_size_positive" CHECK ("data_exports"."byte_size" > 0)
);
--> statement-breakpoint
CREATE TABLE "data_requests" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"type" "data_request_type" NOT NULL,
	"status" "data_request_status" DEFAULT 'requested' NOT NULL,
	"requested_via" varchar(20) DEFAULT 'portal' NOT NULL,
	"note" varchar(500),
	"due_at" timestamp with time zone DEFAULT now() + interval '90 days' NOT NULL,
	"handled_by_user_id" text,
	"decided_at" timestamp with time zone,
	"decision_reason" varchar(40),
	"decision_note" varchar(500),
	"result_summary" jsonb,
	"completed_at" timestamp with time zone,
	"overdue_alerted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_requests_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "data_requests_version_positive" CHECK ("data_requests"."version" > 0),
	CONSTRAINT "data_requests_reason_valid" CHECK ("data_requests"."decision_reason" is null or "data_requests"."decision_reason" in ('verified', 'legal_retention', 'identity_not_confirmed', 'not_this_business', 'duplicate', 'unreasonable', 'other')),
	CONSTRAINT "data_requests_via_valid" CHECK ("data_requests"."requested_via" in ('portal', 'staff', 'email'))
);
--> statement-breakpoint
CREATE TABLE "privacy_notices" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"version" varchar(40) NOT NULL,
	"language" varchar(10) NOT NULL,
	"purposes" jsonb NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_notices_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "privacy_notices_version_uq" UNIQUE("tenant_id","version","language")
);
--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"data_kind" "retention_kind" NOT NULL,
	"keep_days" integer NOT NULL,
	"action" "retention_action" NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_policies_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "retention_policies_kind_uq" UNIQUE("tenant_id","data_kind"),
	CONSTRAINT "retention_policies_days_valid" CHECK ("retention_policies"."keep_days" between 1 and 36500)
);
--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "guardian_name" varchar(120);--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "guardian_relationship" varchar(40);--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "guardian_contact_ciphertext" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "guardian_key_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "guardian_consented_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "erased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."data_requests"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_notices" ADD CONSTRAINT "privacy_notices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_records_latest_idx" ON "consent_records" USING btree ("tenant_id","patient_id","purpose","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_exports_token_uq" ON "data_exports" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "data_requests_open_uq" ON "data_requests" USING btree ("tenant_id","patient_id","type") WHERE "data_requests"."status" in ('requested', 'approved', 'processing');--> statement-breakpoint
CREATE INDEX "data_requests_due_idx" ON "data_requests" USING btree ("tenant_id","status","due_at");
--> statement-breakpoint
-- Customers who already agreed to text and WhatsApp reminders get a first consent row, so the history starts complete.
-- Done before row-level security is switched on, because this runs as the table owner across every business.
INSERT INTO "consent_records" ("tenant_id", "patient_id", "purpose", "granted", "wording_version", "source", "actor_type", "created_at")
SELECT "tenant_id", "id", 'appointment_messages', true, 'legacy', 'import', 'system', "messaging_consent_at"
FROM "patients" WHERE "messaging_consent_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "consent_records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "consent_records" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "privacy_notices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "privacy_notices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "privacy_notices" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "data_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "data_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "data_requests" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "data_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "data_exports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "data_exports" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "retention_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "retention_policies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "retention_policies" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
-- A consent row is evidence. Nobody changes or removes one: not the web app, not the worker, not the table owner.
-- The one way out is kalendr_erase_consent_records() below, which sets a flag that only the table owner's own
-- session (which is what a SECURITY DEFINER function runs as) is allowed to use.
CREATE OR REPLACE FUNCTION "kalendr_consent_records_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $kalendr_consent_append_only$
BEGIN
  IF coalesce(current_setting('kalendr.consent_erase', true), '') = 'on'
     AND current_user = (SELECT pg_get_userbyid(class.relowner) FROM pg_class AS class WHERE class.oid = TG_RELID) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'consent records are never changed or removed' USING ERRCODE = 'check_violation';
END;
$kalendr_consent_append_only$;--> statement-breakpoint
CREATE TRIGGER "consent_records_append_only" BEFORE UPDATE OR DELETE ON "consent_records"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_consent_records_append_only"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "kalendr_erase_consent_records"(p_tenant text, p_patient text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_erase_consent$
DECLARE removed integer;
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '') THEN
    RAISE EXCEPTION 'wrong business scope' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('kalendr.consent_erase', 'on', true);
  DELETE FROM public.consent_records WHERE tenant_id = p_tenant AND patient_id = p_patient;
  GET DIAGNOSTICS removed = ROW_COUNT;
  PERFORM set_config('kalendr.consent_erase', 'off', true);
  RETURN removed;
END;
$kalendr_erase_consent$;--> statement-breakpoint
-- Which business and export a download link belongs to. The link holds a secret token and nothing else, so this
-- finds the business by the token's hash; the download then runs under that business's row-level security.
CREATE OR REPLACE FUNCTION "kalendr_resolve_data_export"(p_token_hash text)
RETURNS TABLE (tenant_id text, export_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_resolve_data_export$
  SELECT export.tenant_id, export.id
  FROM public.data_exports AS export
  JOIN public.tenants AS tenant ON tenant.id = export.tenant_id AND tenant.is_active
  WHERE export.token_hash = p_token_hash
  LIMIT 1
$kalendr_resolve_data_export$;--> statement-breakpoint
-- Replaces a customer's personal details inside old audit rows after an approved erasure. The audit table has no
-- UPDATE for the web app or the worker, so this narrow function does it: it needs an approved erasure request in
-- the current business, changes only an allowlist of top-level metadata keys on rows about that customer, plus any
-- row that holds one of the exact values passed in (full name, phone, email: never a bare first name). It never
-- deletes a row and never touches who did what or when.
CREATE OR REPLACE FUNCTION "kalendr_scrub_audit_personal"(p_request_id text, p_needles text[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_scrub_audit$
DECLARE
  scope_tenant text := nullif(current_setting('app.tenant_id', true), '');
  request_row public.data_requests%ROWTYPE;
  personal_keys text[] := ARRAY['name', 'firstName', 'lastName', 'patientName', 'displayName', 'phone', 'email',
    'contact', 'destination', 'dateOfBirth', 'guardianName', 'guardianContact', 'address'];
  needle text;
  changed integer := 0;
  step integer;
BEGIN
  IF scope_tenant IS NULL THEN
    RAISE EXCEPTION 'no business scope' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO request_row FROM public.data_requests
  WHERE tenant_id = scope_tenant AND id = p_request_id AND type = 'erasure' AND status IN ('approved', 'processing', 'completed');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no approved erasure request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.audit_events AS event
  SET metadata = (
    SELECT coalesce(jsonb_object_agg(entry.key, CASE WHEN entry.key = ANY (personal_keys) THEN to_jsonb('[erased]'::text) ELSE entry.value END), '{}'::jsonb)
    FROM jsonb_each(event.metadata) AS entry
  )
  WHERE event.tenant_id = scope_tenant
    AND event.metadata ?| personal_keys
    AND (
      event.appointment_id IN (SELECT id FROM public.appointments WHERE tenant_id = scope_tenant AND patient_id = request_row.patient_id)
      OR event.metadata ->> 'patientId' = request_row.patient_id
    );
  GET DIAGNOSTICS step = ROW_COUNT;
  changed := changed + step;
  FOREACH needle IN ARRAY coalesce(p_needles, ARRAY[]::text[]) LOOP
    CONTINUE WHEN length(needle) < 6 OR needle ~ '["\\]';
    UPDATE public.audit_events
    SET metadata = replace(metadata::text, needle, '[erased]')::jsonb
    WHERE tenant_id = scope_tenant AND position(needle IN metadata::text) > 0;
    GET DIAGNOSTICS step = ROW_COUNT;
    changed := changed + step;
  END LOOP;
  RETURN changed;
END;
$kalendr_scrub_audit$;--> statement-breakpoint
-- Starting point for a breach investigation: who and what the audit log shows in a time window. Ids only, never
-- content. The admin console action that calls it is feature 15 (not built yet); until then the runbook runs it by hand
-- as the worker role. See docs/INCIDENT_RUNBOOK.md.
CREATE OR REPLACE FUNCTION "kalendr_breach_affected"(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (tenant_id text, kind text, subject_id text, first_seen timestamptz, last_seen timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_breach_affected$
  WITH events AS (
    SELECT event.tenant_id, event.occurred_at, event.actor_user_id, event.actor_type,
      coalesce(
        appointment.patient_id,
        event.metadata ->> 'patientId',
        record.patient_id
      ) AS patient_id
    FROM public.audit_events AS event
    LEFT JOIN public.appointments AS appointment
      ON appointment.tenant_id = event.tenant_id AND appointment.id = event.appointment_id
    LEFT JOIN public.visit_records AS record
      ON record.tenant_id = event.tenant_id AND record.id = event.metadata ->> 'recordId'
    WHERE event.occurred_at >= p_from AND event.occurred_at < p_to
  )
  SELECT events.tenant_id, 'tenant', events.tenant_id, min(events.occurred_at), max(events.occurred_at)
  FROM events GROUP BY events.tenant_id
  UNION ALL
  SELECT events.tenant_id, 'customer', events.patient_id, min(events.occurred_at), max(events.occurred_at)
  FROM events WHERE events.patient_id IS NOT NULL GROUP BY events.tenant_id, events.patient_id
  UNION ALL
  SELECT events.tenant_id, 'staff_user', events.actor_user_id, min(events.occurred_at), max(events.occurred_at)
  FROM events WHERE events.actor_type = 'staff' AND events.actor_user_id IS NOT NULL GROUP BY events.tenant_id, events.actor_user_id
$kalendr_breach_affected$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_consent_records_append_only"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_erase_consent_records"(text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_data_export"(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_scrub_audit_personal"(text, text[]) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_breach_affected"(timestamptz, timestamptz) FROM PUBLIC;
