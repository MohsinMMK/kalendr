ALTER TABLE "auth_users" ADD COLUMN "password_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "permission_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "invited_at" timestamp with time zone;--> statement-breakpoint
-- Everyone who already has an account chose (or was given) a password before invites existed.
UPDATE "auth_users" SET "password_set_at" = "created_at" WHERE "password_set_at" IS NULL;--> statement-breakpoint
-- Like nira_resolve_staff_memberships, plus the membership id and per-person permission overrides,
-- so every request resolves what this person may do right now.
CREATE OR REPLACE FUNCTION "nira_resolve_staff_access"(p_user_id text)
RETURNS TABLE (
  tenant_id text,
  slug text,
  name text,
  membership_id text,
  role membership_role,
  permission_overrides jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $nira_resolve_staff_access$
  SELECT membership.tenant_id, tenant.slug::text, tenant.name::text, membership.id,
    membership.role, membership.permission_overrides
  FROM memberships AS membership
  JOIN tenants AS tenant ON tenant.id = membership.tenant_id
  WHERE membership.user_id = p_user_id
    AND membership.is_active
    AND tenant.is_active
  ORDER BY tenant.name, tenant.id
$nira_resolve_staff_access$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "nira_resolve_staff_access"(text) FROM PUBLIC;
