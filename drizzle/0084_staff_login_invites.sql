-- One login, many businesses: consent. Inviting an email that already has a login no longer adds a membership at once. The
-- invite waits here, under the inviting business's tenant isolation, until the person signs in and accepts it; only then is
-- a membership made. A pending invite is not a membership, so it grants nothing: no access, no notifications, no calendar
-- feed, and it does not count as "held elsewhere" for the person's other businesses.
CREATE TABLE "staff_login_invites" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text,
	"stand_in_user_id" text DEFAULT gen_random_uuid()::text NOT NULL,
	"email" varchar(320) NOT NULL,
	"name" varchar(200) NOT NULL,
	"role" "membership_role" NOT NULL,
	"job_title" varchar(80),
	"permission_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"custom_role_id" text,
	"location_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"practitioner_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"declined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_login_invites_tenant_user_uq" UNIQUE("tenant_id","user_id"),
	CONSTRAINT "staff_login_invites_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "staff_login_invites" ADD CONSTRAINT "staff_login_invites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- "stand_in_user_id" is the user id the business sees for the invite (in answers and on the team list): random, like a new
-- person's, so nothing the business sees tells the two kinds of invite apart. It never matches a login while the invite
-- stands; if the business changes the invite's email, the new person's login is made with it.
-- A deleted login leaves the row behind (the business still sees "invite pending" until it cancels or the invite expires),
-- so the business never learns from a vanished row that the login went away.
ALTER TABLE "staff_login_invites" ADD CONSTRAINT "staff_login_invites_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_login_invites_user_idx" ON "staff_login_invites" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "staff_login_invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "staff_login_invites" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "staff_login_invites"
  FOR ALL
  USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
-- The invites a signed-in person may answer: switched on, not declined, not expired, in an active business they are not
-- already in. Never for a platform operator account. Business ids and names only.
CREATE OR REPLACE FUNCTION "kalendr_staff_invites_for_user"("p_user_id" text)
RETURNS TABLE (
  invite_id text,
  tenant_id text,
  slug text,
  name text,
  role membership_role,
  invited_at timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_staff_invites_for_user$
  SELECT invite.id, invite.tenant_id, tenant.slug::text, tenant.name::text, invite.role, invite.invited_at
  FROM public.staff_login_invites AS invite
  JOIN public.tenants AS tenant ON tenant.id = invite.tenant_id
  WHERE invite.user_id = p_user_id
    AND invite.is_active
    AND invite.declined_at IS NULL
    AND invite.expires_at > now()
    AND tenant.is_active
    AND NOT EXISTS (SELECT 1 FROM public.memberships AS member WHERE member.tenant_id = invite.tenant_id AND member.user_id = p_user_id)
    AND NOT EXISTS (SELECT 1 FROM public.platform_admins AS admin WHERE admin.user_id = p_user_id)
  ORDER BY invite.invited_at DESC, invite.id
$kalendr_staff_invites_for_user$;--> statement-breakpoint
-- The business name behind an invite link, for the page the link opens. Nothing about the person.
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
  WHERE invite.id = p_invite_id AND invite.is_active AND invite.expires_at > now() AND tenant.is_active
$kalendr_staff_invite_business$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_staff_invites_for_user"(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_staff_invite_business"(text) FROM PUBLIC;
