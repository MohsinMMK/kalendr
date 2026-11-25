CREATE TABLE "worker_heartbeats" (
	"worker_id" varchar(80) PRIMARY KEY NOT NULL,
	"mode" varchar(24) NOT NULL,
	"version" varchar(80) NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "worker_heartbeats_last_seen_idx" ON "worker_heartbeats" USING btree ("last_seen_at");--> statement-breakpoint
-- Feature 1: the production worker. The worker connects as its own role with no BYPASSRLS.
-- Everything it does to tenant rows happens after it sets app.tenant_id, as the web app does.
-- The only cross-tenant reads are these narrow definer functions, and each returns ids or
-- counts only. They are revoked from PUBLIC; the release step grants them to the worker role.
--
-- kalendr_claim_outbox: lease up to p_batch_size due outbox rows for 60 seconds. A row is due
-- when it is pending or failed and its time has come, or when another worker's 60-second
-- lease on it has run out (that worker stopped or was killed). p_worker_id is the lease token
-- the worker later checks before it writes, so a row it lost to someone else is left alone.
CREATE OR REPLACE FUNCTION "kalendr_claim_outbox"("p_worker_id" text, "p_batch_size" integer)
RETURNS TABLE ("tenant_id" text, "id" text)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_claim_outbox$
  WITH due AS (
    SELECT event.tenant_id, event.id
    FROM public.outbox_events AS event
    WHERE length(coalesce(p_worker_id, '')) BETWEEN 1 AND 120
      AND (
        (event.status IN ('pending', 'failed') AND event.available_at <= now())
        OR (event.status = 'processing' AND event.locked_at < now() - interval '60 seconds')
      )
    ORDER BY event.available_at, event.id
    FOR UPDATE SKIP LOCKED
    LIMIT least(greatest(coalesce(p_batch_size, 1), 1), 100)
  )
  UPDATE public.outbox_events AS event
  SET status = 'processing',
      locked_at = now(),
      locked_by = p_worker_id,
      attempt_count = event.attempt_count + 1,
      updated_at = now()
  FROM due
  WHERE event.tenant_id = due.tenant_id AND event.id = due.id
  RETURNING event.tenant_id, event.id
$kalendr_claim_outbox$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_claim_outbox"(text, integer) FROM PUBLIC;--> statement-breakpoint
-- Queue health for the heartbeat line and the dead-letter report: four numbers, no ids.
CREATE OR REPLACE FUNCTION "kalendr_outbox_health"()
RETURNS TABLE (
  "pending" integer,
  "oldest_pending_seconds" integer,
  "dead_letters" integer,
  "tenants_with_dead_letters" integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_outbox_health$
  SELECT
    (count(*) FILTER (WHERE status IN ('pending', 'failed', 'processing')))::integer,
    coalesce(extract(epoch FROM now() - min(available_at) FILTER (
      WHERE status IN ('pending', 'failed') AND available_at <= now()
    )), 0)::integer,
    (count(*) FILTER (WHERE status = 'dead_letter'))::integer,
    (count(DISTINCT tenant_id) FILTER (WHERE status = 'dead_letter'))::integer
  FROM public.outbox_events
$kalendr_outbox_health$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_outbox_health"() FROM PUBLIC;--> statement-breakpoint
-- Which businesses a repeating job has work for. Returns tenant ids only; the job then opens
-- each tenant's scope to read and write. The 24-hour reminder window matches
-- REMINDER_LEAD_MS in src/worker/jobs.ts.
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
$kalendr_worker_tenants$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_worker_tenants"(text) FROM PUBLIC;--> statement-breakpoint
-- pg-boss keeps its timed jobs here. The release step gives the worker role USAGE and CREATE
-- on this schema only, so pg-boss can install its own tables. No business data lives here.
CREATE SCHEMA IF NOT EXISTS "kalendr_jobs";--> statement-breakpoint
REVOKE ALL ON SCHEMA "kalendr_jobs" FROM PUBLIC;
