ALTER TABLE "memberships" ADD COLUMN "summary_frequency" varchar(8);--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "summary_sent_for" date;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_summary_frequency_valid" CHECK ("memberships"."summary_frequency" is null or "memberships"."summary_frequency" in ('off', 'weekly', 'monthly'));
--> statement-breakpoint
-- The worker's way to find businesses whose owner has a weekly or monthly summary due, like kalendr_staff_digest_tenants:
-- ids only. A business is listed while an owner's weekly or monthly summary for the period just ended has not been
-- stamped as queued; an owner with no choice of their own gets the weekly one, and "off" is never listed. The job itself
-- decides from the business's own calendar whether today is inside the sending window (the first three days of the week
-- or month), so this stays cheap and never depends on the clock the job is given.
CREATE OR REPLACE FUNCTION "kalendr_owner_summary_tenants"()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_owner_summary_tenants$
  SELECT DISTINCT membership.tenant_id
  FROM public.memberships AS membership
  JOIN public.tenants AS tenant ON tenant.id = membership.tenant_id
  CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE tenant.timezone) AS local_now) AS clock
  WHERE membership.is_active
    AND membership.role = 'owner'
    AND tenant.is_active AND tenant.paused_at IS NULL
    AND (
      (COALESCE(membership.summary_frequency, 'weekly') = 'weekly'
        AND membership.summary_sent_for IS DISTINCT FROM (date_trunc('week', clock.local_now)::date - 7))
      OR
      (membership.summary_frequency = 'monthly'
        AND membership.summary_sent_for IS DISTINCT FROM (date_trunc('month', clock.local_now) - interval '1 month')::date)
    )
$kalendr_owner_summary_tenants$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_owner_summary_tenants"() FROM PUBLIC;
