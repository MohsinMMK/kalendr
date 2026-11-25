CREATE TABLE "onboarding_progress" (
	"tenant_id" text NOT NULL,
	"step_key" varchar(32) NOT NULL,
	"done_at" timestamp with time zone,
	"skipped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_progress_pk" PRIMARY KEY("tenant_id","step_key"),
	CONSTRAINT "onboarding_progress_one_state" CHECK (not ("onboarding_progress"."done_at" is not null and "onboarding_progress"."skipped_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "is_sample" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "onboarding_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Feature 11, the hand-written part: row-level security, the lookups for test and sample rows, the worker's way to find
-- businesses still in their first two weeks, and the admin console's funnel.
ALTER TABLE "onboarding_progress" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "onboarding_progress" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "onboarding_progress"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_step_ck" CHECK ("step_key" IN ('services', 'hours', 'team', 'test_booking', 'reminders', 'brand', 'share_link', 'payments', 'tour', 'sample_data'));--> statement-breakpoint
-- Test and sample rows are few; these keep "remove them" and "leave them out" cheap on a business with many bookings.
CREATE INDEX "appointments_test_idx" ON "appointments" USING btree ("tenant_id") WHERE "is_test";--> statement-breakpoint
CREATE INDEX "patients_test_idx" ON "patients" USING btree ("tenant_id") WHERE "is_test";--> statement-breakpoint
-- Businesses that registered through the guided flow in the last 15 days, for the onboarding email job. Ids only. Worker role only.
CREATE OR REPLACE FUNCTION "kalendr_onboarding_tenants"()
RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $kalendr_onboarding_tenants$
  SELECT tenant.id FROM public.tenants AS tenant
  WHERE tenant.is_active AND tenant.onboarding_started_at > now() - interval '15 days'
$kalendr_onboarding_tenants$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_onboarding_tenants"() FROM PUBLIC;--> statement-breakpoint
-- Where owners drop off: for businesses started in the last p_days days, how many reached, finished and skipped each step,
-- and the median minutes from sign-up to finishing it. Counts only.
CREATE FUNCTION "admin_onboarding_funnel"("p_admin" text, "p_days" integer)
RETURNS TABLE ("step_key" text, "started" integer, "done" integer, "skipped" integer, "median_minutes" integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $admin_onboarding_funnel$
BEGIN
  PERFORM public.kalendr_admin_require(p_admin, ARRAY['support', 'billing', 'super']);
  RETURN QUERY
  WITH cohort AS (
    SELECT tenant.id, tenant.created_at FROM public.tenants AS tenant
    WHERE tenant.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 180)))
  ), steps(step_key) AS (
    VALUES ('services'), ('hours'), ('team'), ('test_booking'), ('reminders'), ('brand'), ('share_link'), ('payments'), ('tour')
  )
  SELECT steps.step_key::text,
    (SELECT count(*)::integer FROM cohort),
    (SELECT count(*)::integer FROM public.onboarding_progress AS progress JOIN cohort ON cohort.id = progress.tenant_id WHERE progress.step_key = steps.step_key AND progress.done_at IS NOT NULL),
    (SELECT count(*)::integer FROM public.onboarding_progress AS progress JOIN cohort ON cohort.id = progress.tenant_id WHERE progress.step_key = steps.step_key AND progress.skipped_at IS NOT NULL),
    (SELECT (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM progress.done_at - cohort.created_at) / 60))::integer
       FROM public.onboarding_progress AS progress JOIN cohort ON cohort.id = progress.tenant_id WHERE progress.step_key = steps.step_key AND progress.done_at IS NOT NULL)
  FROM steps;
END
$admin_onboarding_funnel$;
--> statement-breakpoint
-- "Remove my test and sample data": deletes the bookings flagged is_test and the flagged customers that nothing else refers
-- to. Three things stop a plain delete, and each is handled rather than failed on: audit rows are append-only for the web
-- role and one points at each booking, so this function (owner-run, the only thing that may) unlinks them rather than deleting
-- them; a booking with a payment, a payment order or a visit record is money or a record and is never deleted, so it is
-- retired instead (status entered_in_error, its time released) and stays flagged; and a customer that still has anything
-- pointing at it stays (consent records are append-only, so a customer who has one is kept and counted). It refuses to run
-- outside the business it is asked about.
CREATE FUNCTION "kalendr_purge_test_rows"("p_tenant" text)
RETURNS TABLE ("appointments_removed" integer, "customers_removed" integer, "appointments_retired" integer, "customers_kept" integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $kalendr_purge_test_rows$
DECLARE
  removed_appointments integer;
  removed_customers integer;
  retired_appointments integer;
  customer_ids text[];
  kept_customers integer;
BEGIN
  IF p_tenant IS NULL OR p_tenant <> coalesce(nullif(current_setting('app.tenant_id', true), ''), '') THEN
    RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE = '42501';
  END IF;
  -- Money and records are kept: retire those bookings so they leave the schedule and free their time.
  UPDATE public.resource_reservations SET state = 'released', updated_at = now()
    WHERE tenant_id = p_tenant AND appointment_id IN (
      SELECT id FROM public.appointments WHERE tenant_id = p_tenant AND is_test AND status <> 'entered_in_error'
        AND (EXISTS (SELECT 1 FROM public.payments x WHERE x.tenant_id = p_tenant AND x.appointment_id = appointments.id)
          OR EXISTS (SELECT 1 FROM public.payment_orders x WHERE x.tenant_id = p_tenant AND x.appointment_id = appointments.id)
          OR EXISTS (SELECT 1 FROM public.visit_records x WHERE x.tenant_id = p_tenant AND x.appointment_id = appointments.id)));
  UPDATE public.appointments SET status = 'entered_in_error', version = version + 1, updated_at = now()
    WHERE tenant_id = p_tenant AND is_test AND status <> 'entered_in_error'
      AND (EXISTS (SELECT 1 FROM public.payments x WHERE x.tenant_id = p_tenant AND x.appointment_id = appointments.id)
        OR EXISTS (SELECT 1 FROM public.payment_orders x WHERE x.tenant_id = p_tenant AND x.appointment_id = appointments.id)
        OR EXISTS (SELECT 1 FROM public.visit_records x WHERE x.tenant_id = p_tenant AND x.appointment_id = appointments.id));
  GET DIAGNOSTICS retired_appointments = ROW_COUNT;
  -- Everything else is a plain test booking: unlink its audit rows and delete it.
  UPDATE public.audit_events SET appointment_id = NULL
    WHERE tenant_id = p_tenant AND appointment_id IN (SELECT id FROM public.appointments AS test WHERE test.tenant_id = p_tenant AND test.is_test AND NOT (
      EXISTS (SELECT 1 FROM public.payments x WHERE x.tenant_id = p_tenant AND x.appointment_id = test.id)
      OR EXISTS (SELECT 1 FROM public.payment_orders x WHERE x.tenant_id = p_tenant AND x.appointment_id = test.id)
      OR EXISTS (SELECT 1 FROM public.visit_records x WHERE x.tenant_id = p_tenant AND x.appointment_id = test.id)
      OR EXISTS (SELECT 1 FROM public.appointments x WHERE x.tenant_id = p_tenant AND x.rebooked_from_id = test.id AND NOT x.is_test)));
  DELETE FROM public.appointments AS test WHERE test.tenant_id = p_tenant AND test.is_test AND NOT (
    EXISTS (SELECT 1 FROM public.payments x WHERE x.tenant_id = p_tenant AND x.appointment_id = test.id)
    OR EXISTS (SELECT 1 FROM public.payment_orders x WHERE x.tenant_id = p_tenant AND x.appointment_id = test.id)
    OR EXISTS (SELECT 1 FROM public.visit_records x WHERE x.tenant_id = p_tenant AND x.appointment_id = test.id)
    OR EXISTS (SELECT 1 FROM public.appointments x WHERE x.tenant_id = p_tenant AND x.rebooked_from_id = test.id AND NOT x.is_test));
  GET DIAGNOSTICS removed_appointments = ROW_COUNT;
  SELECT coalesce(array_agg(patient.id), ARRAY[]::text[]) INTO customer_ids FROM public.patients AS patient
    WHERE patient.tenant_id = p_tenant AND patient.is_test
      AND NOT EXISTS (SELECT 1 FROM public.appointments AS booking WHERE booking.tenant_id = p_tenant AND booking.patient_id = patient.id)
      AND NOT EXISTS (SELECT 1 FROM public.appointment_series AS series WHERE series.tenant_id = p_tenant AND series.patient_id = patient.id)
      AND NOT EXISTS (SELECT 1 FROM public.data_requests AS request WHERE request.tenant_id = p_tenant AND request.patient_id = patient.id)
      AND NOT EXISTS (SELECT 1 FROM public.visit_records AS record WHERE record.tenant_id = p_tenant AND record.patient_id = patient.id)
      AND NOT EXISTS (SELECT 1 FROM public.forms AS form WHERE form.tenant_id = p_tenant AND form.patient_id = patient.id)
      AND NOT EXISTS (SELECT 1 FROM public.consent_records AS consent WHERE consent.tenant_id = p_tenant AND consent.patient_id = patient.id);
  DELETE FROM public.patients WHERE tenant_id = p_tenant AND id = ANY (customer_ids);
  GET DIAGNOSTICS removed_customers = ROW_COUNT;
  SELECT count(*)::integer INTO kept_customers FROM public.patients WHERE tenant_id = p_tenant AND is_test;
  RETURN QUERY SELECT removed_appointments, removed_customers, retired_appointments, kept_customers;
END
$kalendr_purge_test_rows$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_purge_test_rows"(text) FROM PUBLIC;
