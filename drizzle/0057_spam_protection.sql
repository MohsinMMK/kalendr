ALTER TYPE "public"."audit_outcome" ADD VALUE 'refused';--> statement-breakpoint
CREATE TABLE "blocklist_entries" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" varchar(12) NOT NULL,
	"value_hash" varchar(64) NOT NULL,
	"hint" varchar(80) NOT NULL,
	"reason_code" varchar(16) NOT NULL,
	"added_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocklist_entries_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "blocklist_entries_kind_valid" CHECK ("blocklist_entries"."kind" in ('email', 'phone', 'email_domain')),
	CONSTRAINT "blocklist_entries_reason_valid" CHECK ("blocklist_entries"."reason_code" in ('fake_details', 'abusive', 'duplicate', 'other'))
);
--> statement-breakpoint
CREATE TABLE "booking_reports" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"reported_by_user_id" text,
	"reason_code" varchar(16) NOT NULL,
	"status" varchar(8) DEFAULT 'open' NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_reports_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "booking_reports_reason_valid" CHECK ("booking_reports"."reason_code" in ('fake_details', 'abusive', 'duplicate', 'other')),
	CONSTRAINT "booking_reports_status_valid" CHECK ("booking_reports"."status" in ('open', 'ignored', 'blocked')),
	CONSTRAINT "booking_reports_decision_pair" CHECK (("booking_reports"."status" = 'open') = ("booking_reports"."decided_at" is null))
);
--> statement-breakpoint
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_cancel_reason_valid";--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "spam_state" varchar(16) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "blocklist_entries" ADD CONSTRAINT "blocklist_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_reports" ADD CONSTRAINT "booking_reports_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_reports" ADD CONSTRAINT "booking_reports_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blocklist_entries_value_uq" ON "blocklist_entries" USING btree ("tenant_id","kind","value_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_reports_appointment_uq" ON "booking_reports" USING btree ("tenant_id","appointment_id");--> statement-breakpoint
CREATE INDEX "booking_reports_status_idx" ON "booking_reports" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_spam_state_valid" CHECK ("appointments"."spam_state" in ('none', 'reported', 'silently_refused'));--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_cancel_reason_valid" CHECK ("appointments"."cancel_reason_code" is null or "appointments"."cancel_reason_code" in ('cant_make_it', 'booked_by_mistake', 'found_another_time', 'feeling_better', 'other', 'staff_preset', 'reschedule_expired', 'spam'));
--> statement-breakpoint
-- Feature 44, the hand-written part: the same forced row-level security policy every business table has.
ALTER TABLE "blocklist_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "blocklist_entries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "blocklist_entries"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "booking_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_reports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking_reports"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
