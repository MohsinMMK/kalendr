CREATE TABLE "appointment_series" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"service_id" text NOT NULL,
	"practitioner_id" text NOT NULL,
	"location_id" text NOT NULL,
	"rule_text" varchar(300) NOT NULL,
	"rule" jsonb NOT NULL,
	"starts_on" date NOT NULL,
	"time_of_day" varchar(5) NOT NULL,
	"duration_minutes" integer NOT NULL,
	"until_on" date,
	"occurrence_count" smallint,
	"status" varchar(12) DEFAULT 'active' NOT NULL,
	"continued_from_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_series_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "appointment_series_status_ck" CHECK ("appointment_series"."status" in ('active', 'ended', 'cancelled')),
	CONSTRAINT "appointment_series_end_ck" CHECK (("appointment_series"."until_on" is null) <> ("appointment_series"."occurrence_count" is null)),
	CONSTRAINT "appointment_series_count_ck" CHECK ("appointment_series"."occurrence_count" is null or "appointment_series"."occurrence_count" between 1 and 52),
	CONSTRAINT "appointment_series_duration_ck" CHECK ("appointment_series"."duration_minutes" > 0),
	CONSTRAINT "appointment_series_version_ck" CHECK ("appointment_series"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "series_id" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "series_index" smallint;--> statement-breakpoint
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_practitioner_fk" FOREIGN KEY ("tenant_id","practitioner_id") REFERENCES "public"."practitioners"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_continued_fk" FOREIGN KEY ("tenant_id","continued_from_id") REFERENCES "public"."appointment_series"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_series_patient_idx" ON "appointment_series" USING btree ("tenant_id","patient_id","status");--> statement-breakpoint
-- Deferred to commit: a series is saved with its first visit, and a brand-new customer only exists once that visit is booked.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_series_fk" FOREIGN KEY ("tenant_id","series_id") REFERENCES "public"."appointment_series"("tenant_id","id") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_series_index_uq" ON "appointments" USING btree ("tenant_id","series_id","series_index") WHERE "appointments"."series_id" is not null;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_series_pair_ck" CHECK (("appointments"."series_id" is null) = ("appointments"."series_index" is null));
--> statement-breakpoint
-- Feature 17, the hand-written part: row-level security on the new table (the same policy every business table has) and the
-- approved-template row for the one message that lists a whole series, so WhatsApp can send it once the template is approved.
ALTER TABLE "appointment_series" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appointment_series" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appointment_series"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
INSERT INTO "message_templates" ("channel", "key", "language", "provider_name", "provider_template_id", "status", "variables", "buttons", "body", "cost_category") VALUES
('whatsapp', 'series_confirmed', 'en', 'kalendr_series_confirmed', NULL, 'pending', '["name","business","service","when","link"]', '[]', NULL, 'utility');
