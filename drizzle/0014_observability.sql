ALTER TABLE "outbox_events" ADD COLUMN "trace_parent" varchar(64);--> statement-breakpoint
-- /api/ready compares this with the newest migration the deployed code expects. The runtime
-- role cannot read the drizzle schema, so this narrow definer function returns one number:
-- the timestamp of the newest applied migration. It reveals no names, versions or rows.
CREATE OR REPLACE FUNCTION "kalendr_schema_version"()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $kalendr_schema_version$
  SELECT max(created_at)::bigint FROM drizzle.__drizzle_migrations
$kalendr_schema_version$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_schema_version"() FROM PUBLIC;
