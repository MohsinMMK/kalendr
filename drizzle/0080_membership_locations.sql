CREATE TABLE "membership_locations" (
	"tenant_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"location_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_locations_pk" PRIMARY KEY("tenant_id","membership_id","location_id")
);
--> statement-breakpoint
ALTER TABLE "membership_locations" ADD CONSTRAINT "membership_locations_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_locations" ADD CONSTRAINT "membership_locations_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "membership_locations_location_idx" ON "membership_locations" USING btree ("tenant_id","location_id");
--> statement-breakpoint
-- Same tenant-isolation policy as every other business table.
ALTER TABLE "membership_locations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "membership_locations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "membership_locations"
  FOR ALL
  USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
-- kalendr_resolve_staff_access now also returns the locations a membership is limited to (empty array = every location).
-- A function's result columns cannot change in place, so it is dropped and made again; whoever could run it still can.
CREATE TEMP TABLE "_staff_access_grantees" AS
  SELECT DISTINCT acl.grantee::regrole::text AS role_name
  FROM pg_proc AS proc, LATERAL aclexplode(proc.proacl) AS acl
  WHERE proc.proname = 'kalendr_resolve_staff_access' AND acl.grantee <> 0 AND acl.grantee <> proc.proowner;--> statement-breakpoint
DROP FUNCTION "kalendr_resolve_staff_access"(text);--> statement-breakpoint
CREATE FUNCTION "kalendr_resolve_staff_access"(p_user_id text)
RETURNS TABLE (
  tenant_id text,
  slug text,
  name text,
  membership_id text,
  role membership_role,
  permission_overrides jsonb,
  location_ids text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_resolve_staff_access$
  SELECT membership.tenant_id, tenant.slug::text, tenant.name::text, membership.id,
    membership.role, membership.permission_overrides,
    coalesce((
      SELECT array_agg(limited.location_id ORDER BY limited.location_id)
      FROM membership_locations AS limited
      WHERE limited.tenant_id = membership.tenant_id AND limited.membership_id = membership.id
    ), '{}'::text[])
  FROM memberships AS membership
  JOIN tenants AS tenant ON tenant.id = membership.tenant_id
  WHERE membership.user_id = p_user_id
    AND membership.is_active
    AND tenant.is_active
  ORDER BY tenant.name, tenant.id
$kalendr_resolve_staff_access$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_staff_access"(text) FROM PUBLIC;--> statement-breakpoint
DO $kalendr_regrant$
DECLARE
  grantee record;
BEGIN
  FOR grantee IN SELECT role_name FROM "_staff_access_grantees" LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION "kalendr_resolve_staff_access"(text) TO %s', grantee.role_name);
  END LOOP;
END
$kalendr_regrant$;--> statement-breakpoint
DROP TABLE "_staff_access_grantees";
