ALTER TYPE "public"."appointment_status" ADD VALUE 'reschedule_requested';--> statement-breakpoint
CREATE TABLE "cancel_note_presets" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"label" varchar(80) NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cancel_note_presets_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "cancel_note_presets_label_uq" UNIQUE("tenant_id","label")
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "cancel_reason_code" varchar(24);--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "cancel_preset_label" varchar(80);--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "cancel_reason_text" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "cancelled_by" varchar(10);--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "reschedule_reason_text" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "reschedule_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "rebooked_from_id" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "allow_customer_cancel" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "allow_customer_reschedule" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "cancel_cutoff_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "reschedule_cutoff_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "reschedule_same_person" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "reschedule_request_days" smallint DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "cancel_note_presets" ADD CONSTRAINT "cancel_note_presets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cancel_note_presets_tenant_idx" ON "cancel_note_presets" USING btree ("tenant_id","sort_order");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_rebooked_from_fk" FOREIGN KEY ("tenant_id","rebooked_from_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_cancelled_by_valid" CHECK ("appointments"."cancelled_by" is null or "appointments"."cancelled_by" in ('customer', 'staff', 'system'));--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_cancel_reason_valid" CHECK ("appointments"."cancel_reason_code" is null or "appointments"."cancel_reason_code" in ('cant_make_it', 'booked_by_mistake', 'found_another_time', 'feeling_better', 'other', 'staff_preset', 'reschedule_expired'));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_cancel_cutoff_range" CHECK ("services"."cancel_cutoff_minutes" between 0 and 43200 and "services"."reschedule_cutoff_minutes" between 0 and 43200);--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_reschedule_request_days_range" CHECK ("services"."reschedule_request_days" between 1 and 60);
--> statement-breakpoint
ALTER TABLE "cancel_note_presets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cancel_note_presets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "cancel_note_presets" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
-- The expiry job and the "Awaiting a new time" filter scan bookings staff asked to move.
-- The self-referencing foreign key above is checked against this on every delete of an appointment.
CREATE INDEX "appointments_rebooked_from_idx" ON "appointments" ("tenant_id", "rebooked_from_id") WHERE "rebooked_from_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "appointments_reschedule_requested_idx" ON "appointments" ("tenant_id", "reschedule_requested_at") WHERE "reschedule_requested_at" IS NOT NULL;--> statement-breakpoint
-- Same function as 0042 with one more job: businesses holding a booking whose customer never chose a new time (see src/worker/request-jobs.ts).
CREATE OR REPLACE FUNCTION "kalendr_worker_tenants"("p_job" text)
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_worker_tenants$
  SELECT appointment.tenant_id
  FROM public.appointments AS appointment
  WHERE p_job = 'reminder_sweep'
    AND appointment.reminder_status = 'queued'
    AND appointment.status IN ('requested', 'booked')
    AND appointment.starts_at > now()
    AND appointment.starts_at <= now() + interval '24 hours'
  UNION
  SELECT reservation.tenant_id
  FROM public.resource_reservations AS reservation
  WHERE p_job = 'hold_expiry'
    AND reservation.state = 'held'
    AND reservation.hold_expires_at <= now()
  UNION
  SELECT tenant.id FROM public.tenants AS tenant WHERE p_job = 'retention'
  UNION
  SELECT event.tenant_id
  FROM public.outbox_events AS event
  WHERE p_job = 'dead_letter_report' AND event.status = 'dead_letter'
  UNION
  SELECT appointment.tenant_id
  FROM public.appointments AS appointment
  WHERE p_job = 'request_expiry'
    AND appointment.status = 'requested'
  UNION
  SELECT appointment.tenant_id
  FROM public.appointments AS appointment
  WHERE p_job = 'reschedule_expiry'
    AND appointment.reschedule_requested_at IS NOT NULL
$kalendr_worker_tenants$;
