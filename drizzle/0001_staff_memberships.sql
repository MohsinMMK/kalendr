-- Bootstrap only a signed-in user's active clinic choices. The runtime role
-- receives EXECUTE, never a cross-tenant SELECT on memberships or tenants.
CREATE OR REPLACE FUNCTION "nira_resolve_staff_memberships"(p_user_id text)
RETURNS TABLE (
  tenant_id text,
  slug text,
  name text,
  role membership_role
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $nira_resolve_staff_memberships$
  SELECT membership.tenant_id, tenant.slug::text, tenant.name::text, membership.role
  FROM memberships AS membership
  JOIN tenants AS tenant ON tenant.id = membership.tenant_id
  WHERE membership.user_id = p_user_id
    AND membership.is_active
    AND tenant.is_active
  ORDER BY tenant.name, tenant.id
$nira_resolve_staff_memberships$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "nira_resolve_staff_memberships"(text) FROM PUBLIC;
