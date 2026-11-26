-- A declined invite's link names no business, also in the database. Declining already deletes the link's token, so this is a
-- second lock on the same door: the function now skips declined invites, as kalendr_staff_invites_for_user does.
CREATE OR REPLACE FUNCTION "kalendr_staff_invite_business"("p_invite_id" text)
RETURNS TABLE (
  name text,
  expires_at timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_staff_invite_business$
  SELECT tenant.name::text, invite.expires_at
  FROM public.staff_login_invites AS invite
  JOIN public.tenants AS tenant ON tenant.id = invite.tenant_id
  WHERE invite.id = p_invite_id
    AND invite.is_active
    AND invite.declined_at IS NULL
    AND invite.expires_at > now()
    AND tenant.is_active
$kalendr_staff_invite_business$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_staff_invite_business"(text) FROM PUBLIC;
