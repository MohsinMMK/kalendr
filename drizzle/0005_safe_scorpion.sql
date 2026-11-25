CREATE TYPE "public"."patient_contact_kind" AS ENUM('email', 'phone');--> statement-breakpoint
CREATE TYPE "public"."visit_record_kind" AS ENUM('note', 'report', 'prescription');--> statement-breakpoint
CREATE TYPE "public"."visit_record_status" AS ENUM('draft', 'shared');--> statement-breakpoint
CREATE TABLE "patient_accounts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"contact_kind" "patient_contact_kind" NOT NULL,
	"contact_value" varchar(254) NOT NULL,
	"last_sign_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_login_codes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"contact_hash" varchar(64) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_record_access" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"account_id" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_method" varchar(40),
	"confirmed_by_user_id" text,
	"requested_at" timestamp with time zone,
	"failed_attempts" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_record_access_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "patient_record_access_person_uq" UNIQUE("tenant_id","patient_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "patient_sessions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"account_id" text NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visit_record_files" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"record_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"name_ciphertext" text NOT NULL,
	"content_type" varchar(80) NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"uploaded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visit_record_files_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "visit_records" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"appointment_id" text,
	"practitioner_id" text,
	"kind" "visit_record_kind" NOT NULL,
	"status" "visit_record_status" DEFAULT 'draft' NOT NULL,
	"title_ciphertext" text NOT NULL,
	"body_ciphertext" text NOT NULL,
	"created_by_user_id" text,
	"first_shared_at" timestamp with time zone,
	"shared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visit_records_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "patient_record_access" ADD CONSTRAINT "patient_record_access_account_id_patient_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."patient_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_record_access" ADD CONSTRAINT "patient_record_access_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_sessions" ADD CONSTRAINT "patient_sessions_account_id_patient_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."patient_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_record_files" ADD CONSTRAINT "visit_record_files_record_fk" FOREIGN KEY ("tenant_id","record_id") REFERENCES "public"."visit_records"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_records" ADD CONSTRAINT "visit_records_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_records" ADD CONSTRAINT "visit_records_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_records" ADD CONSTRAINT "visit_records_practitioner_fk" FOREIGN KEY ("tenant_id","practitioner_id") REFERENCES "public"."practitioners"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_accounts_contact_uq" ON "patient_accounts" USING btree ("contact_kind","contact_value");--> statement-breakpoint
CREATE INDEX "patient_login_codes_contact_idx" ON "patient_login_codes" USING btree ("contact_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_sessions_token_uq" ON "patient_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "patient_sessions_account_idx" ON "patient_sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "visit_record_files_record_idx" ON "visit_record_files" USING btree ("tenant_id","record_id");--> statement-breakpoint
CREATE INDEX "visit_records_patient_idx" ON "visit_records" USING btree ("tenant_id","patient_id","created_at");--> statement-breakpoint
CREATE INDEX "visit_records_timeline_idx" ON "visit_records" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "patient_record_access" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patient_record_access" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "patient_record_access"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "visit_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "visit_records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "visit_records"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "visit_record_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "visit_record_files" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "visit_record_files"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint

-- Numbers reach Nira as "+91 98450 12345", "09845012345" or "9845012345". India is the default country.
CREATE OR REPLACE FUNCTION "nira_normalize_phone"(p_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $nira_normalize_phone$
  SELECT CASE
    WHEN length(digits) = 10 THEN '91' || digits
    WHEN length(digits) = 11 AND digits LIKE '0%' THEN '91' || substr(digits, 2)
    ELSE digits
  END
  FROM (SELECT regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') AS digits) AS cleaned
$nira_normalize_phone$;--> statement-breakpoint
CREATE INDEX "patients_portal_phone_idx" ON "patients" ("nira_normalize_phone"("phone"));--> statement-breakpoint
CREATE INDEX "patients_portal_email_idx" ON "patients" (lower(trim("email")));--> statement-breakpoint
CREATE INDEX "audit_events_record_idx" ON "audit_events" ("tenant_id", ("metadata"->>'recordId'), "occurred_at")
  WHERE "metadata" ? 'recordId';--> statement-breakpoint

-- Every patient record the account's verified contact currently matches. Checked live on each request, so changing a
-- patient's number at the clinic ends the old number's access straight away.
CREATE OR REPLACE FUNCTION "nira_portal_people"(p_account_id text)
RETURNS TABLE (tenant_id text, clinic_slug text, clinic_name text, patient_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $nira_portal_people$
  SELECT patient.tenant_id, tenant.slug::text, tenant.name::text, patient.id
  FROM patient_accounts AS account
  JOIN patients AS patient
    ON account.contact_kind = 'phone' AND "nira_normalize_phone"(patient.phone) = account.contact_value
  JOIN tenants AS tenant ON tenant.id = patient.tenant_id AND tenant.is_active
  WHERE account.id = p_account_id AND account.contact_value <> ''
  UNION ALL
  SELECT patient.tenant_id, tenant.slug::text, tenant.name::text, patient.id
  FROM patient_accounts AS account
  JOIN patients AS patient
    ON account.contact_kind = 'email' AND lower(trim(patient.email)) = account.contact_value
  JOIN tenants AS tenant ON tenant.id = patient.tenant_id AND tenant.is_active
  WHERE account.id = p_account_id AND account.contact_value <> ''
$nira_portal_people$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "nira_portal_people"(text) FROM PUBLIC;
