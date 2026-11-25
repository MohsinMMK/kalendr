ALTER TABLE "memberships" ADD COLUMN "quiet_start_minute" smallint;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "quiet_end_minute" smallint;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "digest_enabled" boolean;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "digest_minute" smallint;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "digest_sent_on" date;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_quiet_hours_valid" CHECK (("memberships"."quiet_start_minute" is null and "memberships"."quiet_end_minute" is null) or ("memberships"."quiet_start_minute" between 0 and 1439 and "memberships"."quiet_end_minute" between 0 and 1439 and "memberships"."quiet_start_minute" <> "memberships"."quiet_end_minute"));--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_digest_minute_valid" CHECK ("memberships"."digest_minute" is null or "memberships"."digest_minute" between 0 and 1439);
--> statement-breakpoint
-- Feature 56, the hand-written part: the worker's way to find businesses that have a morning digest due, like
-- kalendr_workflow_tenants: ids only. A business is listed while a member's digest is on (their own choice, or on by
-- default for owners and admins) and has not gone out for the business's local day yet.
CREATE OR REPLACE FUNCTION "kalendr_staff_digest_tenants"()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_staff_digest_tenants$
  SELECT DISTINCT membership.tenant_id
  FROM public.memberships AS membership
  JOIN public.tenants AS tenant ON tenant.id = membership.tenant_id
  WHERE membership.is_active
    AND tenant.is_active AND tenant.paused_at IS NULL
    AND COALESCE(membership.digest_enabled, membership.role IN ('owner', 'admin'))
    AND membership.digest_sent_on IS DISTINCT FROM (now() AT TIME ZONE tenant.timezone)::date
    AND (EXTRACT(HOUR FROM (now() AT TIME ZONE tenant.timezone)) * 60 + EXTRACT(MINUTE FROM (now() AT TIME ZONE tenant.timezone)))
        >= COALESCE(membership.digest_minute, 420)
$kalendr_staff_digest_tenants$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_staff_digest_tenants"() FROM PUBLIC;
