CREATE TABLE "app_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"app_key" varchar(40) NOT NULL,
	"event_type" varchar(40) NOT NULL,
	"outcome" varchar(12) NOT NULL,
	"error_code" varchar(40),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_events_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "app_events_outcome_ck" CHECK ("app_events"."outcome" in ('delivered', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "app_installs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"app_key" varchar(40) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credentials_ciphertext" text,
	"key_version" integer,
	"installed_by_user_id" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"disabled_reason" varchar(32),
	"version" integer DEFAULT 1 NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_installs_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "app_installs_tenant_app_uq" UNIQUE("tenant_id","app_key"),
	CONSTRAINT "app_installs_status_ck" CHECK ("app_installs"."status" in ('active', 'paused', 'failing', 'uninstalling')),
	CONSTRAINT "app_installs_key_ck" CHECK ("app_installs"."app_key" ~ '^[a-z][a-z0-9-]{1,39}$'),
	CONSTRAINT "app_installs_credentials_ck" CHECK (("app_installs"."credentials_ciphertext" is null) = ("app_installs"."key_version" is null))
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"name" varchar(60) NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"scopes" text[] NOT NULL,
	"secret_hash" varchar(64) NOT NULL,
	"secret_prefix" varchar(16) NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "oauth_clients_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "oauth_clients_redirects_ck" CHECK (cardinality("oauth_clients"."redirect_uris") between 1 and 5),
	CONSTRAINT "oauth_clients_scopes_ck" CHECK (cardinality("oauth_clients"."scopes") between 1 and 20)
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"code_challenge" varchar(43) NOT NULL,
	"redirect_uri" varchar(600) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_codes_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"client_kind" varchar(8) NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"client_name" varchar(60) NOT NULL,
	"user_id" text NOT NULL,
	"scopes" text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "oauth_grants_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "oauth_grants_kind_ck" CHECK ("oauth_grants"."client_kind" in ('builtin', 'custom')),
	CONSTRAINT "oauth_grants_scopes_ck" CHECK (cardinality("oauth_grants"."scopes") between 1 and 20)
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"kind" varchar(8) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_tokens_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "oauth_tokens_kind_ck" CHECK ("oauth_tokens"."kind" in ('access', 'refresh'))
);
--> statement-breakpoint
ALTER TABLE "app_events" ADD CONSTRAINT "app_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_installs" ADD CONSTRAINT "app_installs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_grant_fk" FOREIGN KEY ("tenant_id","grant_id") REFERENCES "public"."oauth_grants"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_grant_fk" FOREIGN KEY ("tenant_id","grant_id") REFERENCES "public"."oauth_grants"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_events_app_idx" ON "app_events" USING btree ("tenant_id","app_key","created_at");--> statement-breakpoint
CREATE INDEX "app_installs_active_idx" ON "app_installs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "oauth_clients_list_idx" ON "oauth_clients" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_codes_hash_uq" ON "oauth_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "oauth_codes_grant_idx" ON "oauth_codes" USING btree ("tenant_id","grant_id");--> statement-breakpoint
CREATE INDEX "oauth_grants_list_idx" ON "oauth_grants" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_tokens_hash_uq" ON "oauth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "oauth_tokens_grant_idx" ON "oauth_tokens" USING btree ("tenant_id","grant_id");
--> statement-breakpoint
-- Feature 55, the hand-written part: row-level security on every new table, then the narrow lookups a request with
-- only a token can use. Each returns ids and scopes, never a hash or a secret.
ALTER TABLE "app_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "app_events"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "app_installs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_installs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "app_installs"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "oauth_clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_clients" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "oauth_clients"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "oauth_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_codes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "oauth_codes"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "oauth_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "oauth_grants"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "oauth_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_tokens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "oauth_tokens"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "kalendr_resolve_oauth_token"("p_hash" text)
  RETURNS TABLE ("tenant_id" text, "token_id" text, "grant_id" text, "scopes" text[], "user_id" text, "client_name" text, "clinic_slug" text, "clinic_name" text, "last_used_at" timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_resolve_oauth_token$
  select token.tenant_id, token.id, token.grant_id, grant_row.scopes, grant_row.user_id, grant_row.client_name, tenant.slug, tenant.name, grant_row.last_used_at
  from oauth_tokens as token
  join oauth_grants as grant_row on grant_row.tenant_id = token.tenant_id and grant_row.id = token.grant_id
  join tenants as tenant on tenant.id = token.tenant_id
  join memberships as member on member.tenant_id = grant_row.tenant_id and member.user_id = grant_row.user_id
  where token.token_hash = "p_hash" and token.kind = 'access' and token.revoked_at is null and token.expires_at > now()
    and grant_row.revoked_at is null and member.is_active and tenant.is_active
  limit 1
$kalendr_resolve_oauth_token$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_oauth_token"(text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "kalendr_resolve_oauth_code"("p_hash" text)
  RETURNS TABLE ("tenant_id" text, "code_id" text, "grant_id" text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_resolve_oauth_code$
  select code.tenant_id, code.id, code.grant_id from oauth_codes as code where code.code_hash = "p_hash" limit 1
$kalendr_resolve_oauth_code$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_oauth_code"(text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "kalendr_resolve_oauth_refresh"("p_hash" text)
  RETURNS TABLE ("tenant_id" text, "token_id" text, "grant_id" text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_resolve_oauth_refresh$
  select token.tenant_id, token.id, token.grant_id from oauth_tokens as token
  where token.token_hash = "p_hash" and token.kind = 'refresh' limit 1
$kalendr_resolve_oauth_refresh$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_oauth_refresh"(text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "kalendr_resolve_oauth_client"("p_id" text)
  RETURNS TABLE ("tenant_id" text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_resolve_oauth_client$
  select client.tenant_id from oauth_clients as client where client.id = "p_id" limit 1
$kalendr_resolve_oauth_client$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_oauth_client"(text) FROM PUBLIC;
