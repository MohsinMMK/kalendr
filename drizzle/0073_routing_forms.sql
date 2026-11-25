CREATE TABLE "routing_form_versions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"form_id" text NOT NULL,
	"version" integer NOT NULL,
	"name" varchar(120) NOT NULL,
	"intro" varchar(300) DEFAULT '' NOT NULL,
	"definition" jsonb NOT NULL,
	"published_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_form_versions_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "routing_form_versions_form_version_uq" UNIQUE("tenant_id","form_id","version"),
	CONSTRAINT "routing_form_versions_version_ck" CHECK ("routing_form_versions"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "routing_forms" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"key" text DEFAULT gen_random_uuid()::text NOT NULL,
	"name" varchar(120) NOT NULL,
	"slug" varchar(60) NOT NULL,
	"intro" varchar(300) DEFAULT '' NOT NULL,
	"definition" jsonb NOT NULL,
	"status" varchar(8) DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"live_version" integer,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_forms_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "routing_forms_tenant_slug_uq" UNIQUE("tenant_id","slug"),
	CONSTRAINT "routing_forms_status_ck" CHECK ("routing_forms"."status" in ('draft', 'live')),
	CONSTRAINT "routing_forms_live_ck" CHECK ("routing_forms"."status" <> 'live' or "routing_forms"."live_version" is not null)
);
--> statement-breakpoint
CREATE TABLE "routing_responses" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"form_id" text NOT NULL,
	"form_version" integer NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"answers_ciphertext" text,
	"key_version" integer DEFAULT 0 NOT NULL,
	"route_id" varchar(80),
	"route_name" varchar(120),
	"destination_type" varchar(8),
	"service_id" text,
	"candidate_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"multipliers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trace" jsonb,
	"outcome" varchar(10) DEFAULT 'pending' NOT NULL,
	"appointment_id" text,
	"patient_id" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"slot_shown_at" timestamp with time zone,
	"booked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_responses_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "routing_responses_outcome_ck" CHECK ("routing_responses"."outcome" in ('pending', 'booked', 'external', 'message')),
	CONSTRAINT "routing_responses_destination_ck" CHECK ("routing_responses"."destination_type" is null or "routing_responses"."destination_type" in ('service', 'external', 'message')),
	CONSTRAINT "routing_responses_booked_ck" CHECK ("routing_responses"."outcome" <> 'booked' or "routing_responses"."appointment_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "wrong_assignment_reports" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"reported_by_user_id" text NOT NULL,
	"correct_practitioner_id" text,
	"note_ciphertext" text,
	"key_version" integer DEFAULT 0 NOT NULL,
	"status" varchar(10) DEFAULT 'open' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wrong_assignment_reports_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "wrong_assignment_reports_status_ck" CHECK ("wrong_assignment_reports"."status" in ('open', 'fixed', 'dismissed'))
);
--> statement-breakpoint
ALTER TABLE "campaigns" DROP CONSTRAINT "campaigns_rule_ck";--> statement-breakpoint
ALTER TABLE "routing_form_versions" ADD CONSTRAINT "routing_form_versions_form_fk" FOREIGN KEY ("tenant_id","form_id") REFERENCES "public"."routing_forms"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_forms" ADD CONSTRAINT "routing_forms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_responses" ADD CONSTRAINT "routing_responses_form_fk" FOREIGN KEY ("tenant_id","form_id") REFERENCES "public"."routing_forms"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_responses" ADD CONSTRAINT "routing_responses_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wrong_assignment_reports" ADD CONSTRAINT "wrong_assignment_reports_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wrong_assignment_reports" ADD CONSTRAINT "wrong_assignment_reports_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wrong_assignment_reports" ADD CONSTRAINT "wrong_assignment_reports_practitioner_fk" FOREIGN KEY ("tenant_id","correct_practitioner_id") REFERENCES "public"."practitioners"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "routing_responses_token_uq" ON "routing_responses" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "routing_responses_appointment_uq" ON "routing_responses" USING btree ("tenant_id","appointment_id") WHERE "routing_responses"."appointment_id" is not null;--> statement-breakpoint
CREATE INDEX "routing_responses_form_idx" ON "routing_responses" USING btree ("tenant_id","form_id","opened_at");--> statement-breakpoint
CREATE INDEX "wrong_assignment_reports_status_idx" ON "wrong_assignment_reports" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_rule_ck" CHECK (("campaigns"."kind" = 'automated') = ("campaigns"."rule_type" is not null) and ("campaigns"."rule_type" is null or "campaigns"."rule_type" in ('recall', 'birthday', 'win_back', 'package_expiring', 'routing_abandoned')));
--> statement-breakpoint
-- Feature 46, the hand-written part: row-level security on the four routing tables, like every business table.
ALTER TABLE "routing_forms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "routing_forms" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "routing_forms"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "routing_form_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "routing_form_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "routing_form_versions"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "routing_responses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "routing_responses" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "routing_responses"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "wrong_assignment_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wrong_assignment_reports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "wrong_assignment_reports"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
