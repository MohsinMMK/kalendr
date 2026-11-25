ALTER TABLE "auth_users" ADD COLUMN "last_sign_in_at" timestamp with time zone;--> statement-breakpoint
-- Removing someone from a business frees their email for a new invite, but only when they belong to no other business. The
-- runtime role sees one business at a time, so this definer function does the check across all of them and deletes the
-- login (and, by cascade, its sessions, accounts, passkeys and second factors) only when nothing else uses it.
CREATE OR REPLACE FUNCTION "kalendr_delete_orphan_user"("p_user_id" text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_delete_orphan_user$
BEGIN
  IF EXISTS (SELECT 1 FROM public.memberships WHERE user_id = p_user_id)
     OR EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = p_user_id) THEN
    RETURN false;
  END IF;
  DELETE FROM public.auth_verifications WHERE value = p_user_id;
  DELETE FROM public.auth_users WHERE id = p_user_id;
  RETURN true;
END
$kalendr_delete_orphan_user$;
