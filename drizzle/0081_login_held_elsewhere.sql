-- A business may not change a login that another business also relies on (its email, its password, its sessions). The
-- runtime role sees one business at a time, and kalendr_resolve_staff_access only lists active memberships in active
-- businesses, so a person switched off in A, or working in a suspended A, looked like a one-business login to B. This definer
-- function answers the question the way kalendr_delete_orphan_user does: any membership in another business, active or not,
-- or a platform operator account, means the login is held elsewhere.
CREATE OR REPLACE FUNCTION "kalendr_login_held_elsewhere"("p_user_id" text, "p_tenant_id" text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_login_held_elsewhere$
  SELECT EXISTS (SELECT 1 FROM public.memberships WHERE user_id = p_user_id AND tenant_id <> p_tenant_id)
      OR EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = p_user_id)
$kalendr_login_held_elsewhere$;
