CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"name" varchar(80) NOT NULL,
	"prefix" varchar(24) NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"scopes" text[] NOT NULL,
	"mode" varchar(8) DEFAULT 'live' NOT NULL,
	"created_by_user_id" text,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "api_keys_mode_ck" CHECK ("api_keys"."mode" in ('live', 'test')),
	CONSTRAINT "api_keys_scopes_ck" CHECK (cardinality("api_keys"."scopes") between 1 and 20)
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"event_id" varchar(80) NOT NULL,
	"event_type" varchar(60) NOT NULL,
	"payload" jsonb NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"attempt" smallint DEFAULT 0 NOT NULL,
	"status_code" smallint,
	"duration_ms" integer,
	"error_code" varchar(40),
	"next_attempt_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"resend_of_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "webhook_deliveries_status_ck" CHECK ("webhook_deliveries"."status" in ('pending', 'succeeded', 'retrying', 'gave_up'))
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"url" varchar(2000) NOT NULL,
	"description" varchar(120),
	"secret_ciphertext" text NOT NULL,
	"key_version" integer NOT NULL,
	"events" text[] NOT NULL,
	"status" varchar(12) DEFAULT 'active' NOT NULL,
	"consecutive_failures" smallint DEFAULT 0 NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_reason" varchar(24),
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "webhook_endpoints_status_ck" CHECK ("webhook_endpoints"."status" in ('active', 'disabled')),
	CONSTRAINT "webhook_endpoints_events_ck" CHECK (cardinality("webhook_endpoints"."events") between 1 and 20)
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_fk" FOREIGN KEY ("tenant_id","endpoint_id") REFERENCES "public"."webhook_endpoints"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_uq" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_list_idx" ON "api_keys" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_uq" ON "webhook_deliveries" USING btree ("tenant_id","endpoint_id","event_id") WHERE "webhook_deliveries"."resend_of_id" is null;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_log_idx" ON "webhook_deliveries" USING btree ("tenant_id","endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_list_idx" ON "webhook_endpoints" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "api_keys"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_endpoints"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_deliveries"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
-- A request with an API key names no business, so the key's hash is the only way in. This returns the ids and scopes
-- of a key that is neither revoked nor expired, and the business's address name, and nothing else.
CREATE OR REPLACE FUNCTION "kalendr_resolve_api_key"("p_hash" text)
  RETURNS TABLE ("tenant_id" text, "key_id" text, "prefix" text, "scopes" text[], "mode" text, "clinic_slug" text, "clinic_name" text, "last_used_at" timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_resolve_api_key$
  select key.tenant_id, key.id, key.prefix, key.scopes, key.mode, tenant.slug, tenant.name, key.last_used_at
  from api_keys as key
  join tenants as tenant on tenant.id = key.tenant_id
  where key.key_hash = "p_hash" and key.revoked_at is null and (key.expires_at is null or key.expires_at > now())
  limit 1
$kalendr_resolve_api_key$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_api_key"(text) FROM PUBLIC;
