ALTER TYPE "public"."appointment_status" ADD VALUE IF NOT EXISTS 'declined';--> statement-breakpoint
ALTER TYPE "public"."appointment_status" ADD VALUE IF NOT EXISTS 'expired';--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "decline_reason_code" varchar(24);--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "proposed_starts" timestamp with time zone[];--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "approval_rule" varchar(16) DEFAULT 'never' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "approval_notice_hours" smallint DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "requests_hold_slot" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "hide_location_until_confirmed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_proposed_starts_max" CHECK ("appointments"."proposed_starts" is null or cardinality("appointments"."proposed_starts") <= 10);--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_decline_reason_valid" CHECK ("appointments"."decline_reason_code" is null or "appointments"."decline_reason_code" in ('fully_booked', 'outside_services', 'need_information', 'other'));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_approval_rule_valid" CHECK ("services"."approval_rule" in ('never', 'always', 'short_notice', 'free_mail'));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_approval_notice_range" CHECK ("services"."approval_notice_hours" between 1 and 720);
--> statement-breakpoint
-- Every service that took requests before now approves every booking. booking_mode stays in step for older code paths.
UPDATE "services" SET "approval_rule" = 'always' WHERE "booking_mode" = 'request';--> statement-breakpoint
-- Staff list the waiting requests (the "Needs approval" tab) and the expiry job scans them by start time.
CREATE INDEX "appointments_requested_idx" ON "appointments" ("tenant_id", "starts_at") WHERE "status" = 'requested';--> statement-breakpoint
-- Same function as 0015 with one more job: businesses that hold a request (see src/worker/jobs.ts).
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
$kalendr_worker_tenants$;
