CREATE TABLE "attribute_definitions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"name" varchar(60) NOT NULL,
	"kind" varchar(12) NOT NULL,
	"options" text[] DEFAULT '{}'::text[] NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attribute_definitions_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "attribute_definitions_tenant_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "attribute_definitions_kind_ck" CHECK ("attribute_definitions"."kind" in ('text', 'single', 'multiple', 'number'))
);
--> statement-breakpoint
CREATE TABLE "custom_roles" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"name" varchar(80) NOT NULL,
	"description" varchar(240),
	"base_role" "membership_role" NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_roles_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "custom_roles_tenant_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "custom_roles_base_not_owner_ck" CHECK ("custom_roles"."base_role" <> 'owner')
);
--> statement-breakpoint
CREATE TABLE "practitioner_attributes" (
	"tenant_id" text NOT NULL,
	"practitioner_id" text NOT NULL,
	"attribute_id" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practitioner_attributes_pk" PRIMARY KEY("tenant_id","practitioner_id","attribute_id")
);
--> statement-breakpoint
CREATE TABLE "scim_tokens" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"name" varchar(80) NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" varchar(12) NOT NULL,
	"default_role" "membership_role" DEFAULT 'read_only' NOT NULL,
	"created_by_user_id" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_tokens_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "scim_tokens_default_role_ck" CHECK ("scim_tokens"."default_role" not in ('owner', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "sso_connections" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"kind" varchar(8) NOT NULL,
	"status" varchar(12) DEFAULT 'draft' NOT NULL,
	"idp_entity_id" varchar(500),
	"idp_sso_url" varchar(1000),
	"idp_certificate" text,
	"oidc_issuer" varchar(500),
	"oidc_client_id" varchar(300),
	"oidc_client_secret_enc" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_connections_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "sso_connections_domain_uq" UNIQUE("tenant_id","domain_id"),
	CONSTRAINT "sso_connections_kind_ck" CHECK ("sso_connections"."kind" in ('saml', 'oidc')),
	CONSTRAINT "sso_connections_status_ck" CHECK ("sso_connections"."status" in ('draft', 'active', 'disabled')),
	CONSTRAINT "sso_connections_saml_ck" CHECK ("sso_connections"."kind" <> 'saml' or ("sso_connections"."idp_entity_id" is not null and "sso_connections"."idp_sso_url" is not null and "sso_connections"."idp_certificate" is not null)),
	CONSTRAINT "sso_connections_oidc_ck" CHECK ("sso_connections"."kind" <> 'oidc' or ("sso_connections"."oidc_issuer" is not null and "sso_connections"."oidc_client_id" is not null and "sso_connections"."oidc_client_secret_enc" is not null))
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"tenant_id" text NOT NULL,
	"team_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_pk" PRIMARY KEY("tenant_id","team_id","membership_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"parent_team_id" text,
	"location_id" text,
	"name" varchar(120) NOT NULL,
	"slug" varchar(80) NOT NULL,
	"description" text,
	"is_private" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "teams_tenant_slug_uq" UNIQUE("tenant_id","slug"),
	CONSTRAINT "teams_slug_ck" CHECK ("teams"."slug" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
	CONSTRAINT "teams_not_own_parent_ck" CHECK ("teams"."parent_team_id" is null or "teams"."parent_team_id" <> "teams"."id")
);
--> statement-breakpoint
CREATE TABLE "verified_domains" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"domain" varchar(253) NOT NULL,
	"token_hash" text NOT NULL,
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_check_note" varchar(200),
	"auto_join_enabled" boolean DEFAULT false NOT NULL,
	"auto_join_role" "membership_role" DEFAULT 'read_only' NOT NULL,
	"require_sso" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verified_domains_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "verified_domains_tenant_domain_uq" UNIQUE("tenant_id","domain"),
	CONSTRAINT "verified_domains_domain_ck" CHECK ("verified_domains"."domain" = lower("verified_domains"."domain") and "verified_domains"."domain" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
	CONSTRAINT "verified_domains_auto_join_role_ck" CHECK ("verified_domains"."auto_join_role" not in ('owner', 'admin'))
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "custom_role_id" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "scim_external_id" varchar(255);--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "break_glass" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "defaults" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_roles" ADD CONSTRAINT "custom_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner_attributes" ADD CONSTRAINT "practitioner_attributes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner_attributes" ADD CONSTRAINT "practitioner_attributes_practitioner_fk" FOREIGN KEY ("tenant_id","practitioner_id") REFERENCES "public"."practitioners"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner_attributes" ADD CONSTRAINT "practitioner_attributes_attribute_fk" FOREIGN KEY ("tenant_id","attribute_id") REFERENCES "public"."attribute_definitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_domain_fk" FOREIGN KEY ("tenant_id","domain_id") REFERENCES "public"."verified_domains"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_fk" FOREIGN KEY ("tenant_id","team_id") REFERENCES "public"."teams"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_parent_fk" FOREIGN KEY ("tenant_id","parent_team_id") REFERENCES "public"."teams"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_domains" ADD CONSTRAINT "verified_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scim_tokens_hash_uq" ON "scim_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "team_members_membership_idx" ON "team_members" USING btree ("tenant_id","membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verified_domains_proved_uq" ON "verified_domains" USING btree ("domain") WHERE "verified_domains"."verified_at" is not null;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_custom_role_fk" FOREIGN KEY ("tenant_id","custom_role_id") REFERENCES "public"."custom_roles"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_break_glass_uq" ON "memberships" USING btree ("tenant_id") WHERE "memberships"."break_glass";--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_scim_external_uq" ON "memberships" USING btree ("tenant_id","scim_external_id") WHERE "memberships"."scim_external_id" is not null;
--> statement-breakpoint
-- Feature 53, the hand-written part. Row-level security on every new table: the policy every business table has.
ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "teams" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "teams"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "team_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_members" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "team_members"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "custom_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "custom_roles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "custom_roles"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "verified_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "verified_domains" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "verified_domains"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "sso_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sso_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sso_connections"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "scim_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scim_tokens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "scim_tokens"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "attribute_definitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attribute_definitions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "attribute_definitions"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "practitioner_attributes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "practitioner_attributes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "practitioner_attributes"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
-- Enterprise features are a plan feature: only Scale has them until the owner's plan catalogue says otherwise.
UPDATE "plans" SET "limits" = jsonb_set("limits", '{features,enterprise}', to_jsonb("key" = 'scale'), true);--> statement-breakpoint
-- A business always keeps one active owner. The server checks first and says why in words; this is the rule that holds
-- even when a bug or a direct query tries to break it. A business being deleted is allowed through.
CREATE OR REPLACE FUNCTION "kalendr_keep_one_owner"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_keep_one_owner$
BEGIN
  IF OLD.role = 'owner' AND OLD.is_active
     AND (TG_OP = 'DELETE' OR NEW.role <> 'owner' OR NOT NEW.is_active OR NEW.tenant_id <> OLD.tenant_id)
     AND EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.memberships
       WHERE tenant_id = OLD.tenant_id AND id <> OLD.id AND role = 'owner' AND is_active
     ) THEN
    RAISE EXCEPTION 'a business must keep at least one active owner' USING ERRCODE = '23514', CONSTRAINT = 'memberships_keep_one_owner';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$kalendr_keep_one_owner$;--> statement-breakpoint
CREATE TRIGGER "memberships_keep_one_owner"
  BEFORE UPDATE OR DELETE ON "memberships"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_keep_one_owner"();--> statement-breakpoint
-- Company sign-in starts from an email address, before anyone is signed in, so there is no business to scope to. This
-- returns the ids of the active connection for a proved domain, and nothing else.
CREATE OR REPLACE FUNCTION "kalendr_resolve_sso_domain"("p_domain" text)
RETURNS TABLE ("tenant_id" text, "connection_id" text, "kind" text, "require_sso" boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_resolve_sso_domain$
  SELECT connection.tenant_id, connection.id, connection.kind, domain.require_sso
  FROM public.verified_domains AS domain
  JOIN public.sso_connections AS connection ON connection.tenant_id = domain.tenant_id AND connection.domain_id = domain.id
  JOIN public.tenants AS tenant ON tenant.id = domain.tenant_id
  WHERE domain.domain = lower("p_domain") AND domain.verified_at IS NOT NULL
    AND connection.status = 'active' AND tenant.is_active AND tenant.paused_at IS NULL
  LIMIT 1
$kalendr_resolve_sso_domain$;--> statement-breakpoint
-- The identity provider answers to a connection id in the address. This finds that connection's business and domain.
CREATE OR REPLACE FUNCTION "kalendr_resolve_sso_connection"("p_connection" text)
RETURNS TABLE ("tenant_id" text, "domain" text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_resolve_sso_connection$
  SELECT connection.tenant_id, domain.domain
  FROM public.sso_connections AS connection
  JOIN public.verified_domains AS domain ON domain.tenant_id = connection.tenant_id AND domain.id = connection.domain_id
  JOIN public.tenants AS tenant ON tenant.id = connection.tenant_id
  WHERE connection.id = "p_connection" AND connection.status = 'active' AND domain.verified_at IS NOT NULL
    AND tenant.is_active AND tenant.paused_at IS NULL
$kalendr_resolve_sso_connection$;--> statement-breakpoint
-- Which businesses make this person use company sign-in. Used when a session is made by any other means, to refuse it.
CREATE OR REPLACE FUNCTION "kalendr_sso_required_for_user"("p_user_id" text)
RETURNS TABLE ("tenant_id" text, "break_glass" boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_sso_required_for_user$
  SELECT membership.tenant_id, membership.break_glass
  FROM public.memberships AS membership
  JOIN public.auth_users AS person ON person.id = membership.user_id
  JOIN public.verified_domains AS domain ON domain.tenant_id = membership.tenant_id
    AND domain.domain = lower(split_part(person.email, '@', 2))
  JOIN public.sso_connections AS connection ON connection.tenant_id = domain.tenant_id AND connection.domain_id = domain.id
  WHERE membership.user_id = "p_user_id" AND membership.is_active
    AND domain.verified_at IS NOT NULL AND domain.require_sso AND connection.status = 'active'
$kalendr_sso_required_for_user$;--> statement-breakpoint
-- A SCIM request has only a bearer token. Returns the business and token of one that is not revoked.
CREATE OR REPLACE FUNCTION "kalendr_resolve_scim_token"("p_hash" text)
RETURNS TABLE ("tenant_id" text, "token_id" text, "default_role" text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_resolve_scim_token$
  SELECT token.tenant_id, token.id, token.default_role::text
  FROM public.scim_tokens AS token
  JOIN public.tenants AS tenant ON tenant.id = token.tenant_id
  WHERE token.token_hash = "p_hash" AND token.revoked_at IS NULL AND tenant.is_active AND tenant.paused_at IS NULL
  LIMIT 1
$kalendr_resolve_scim_token$;--> statement-breakpoint
-- The worker's way to find businesses with a domain still waiting to be proved (checked for a week after it is added).
CREATE OR REPLACE FUNCTION "kalendr_email_domain_tenants"()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_email_domain_tenants$
  SELECT DISTINCT domain.tenant_id
  FROM public.verified_domains AS domain
  WHERE domain.verified_at IS NULL AND domain.created_at > now() - interval '7 days'
$kalendr_email_domain_tenants$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_keep_one_owner"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_sso_domain"(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_sso_connection"(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_sso_required_for_user"(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_scim_token"(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_email_domain_tenants"() FROM PUBLIC;
