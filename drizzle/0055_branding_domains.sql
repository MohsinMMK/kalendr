CREATE TABLE "tenant_embed_origins" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"origin" varchar(253) NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_embed_origins_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "tenant_domains" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_domains" ADD COLUMN "last_result" varchar(24);--> statement-breakpoint
ALTER TABLE "tenant_domains" ADD COLUMN "check_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_domains" ADD COLUMN "missing_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "brand" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_embed_origins" ADD CONSTRAINT "tenant_embed_origins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_embed_origins_origin_uq" ON "tenant_embed_origins" USING btree ("tenant_id","origin");--> statement-breakpoint
-- Feature 13, the hand-written part: row-level security and shape checks on the new table, then the lookups the
-- proxy, the certificate check and the worker need. They return ids, slugs and origins only.
ALTER TABLE "tenant_embed_origins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_embed_origins" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_embed_origins"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
-- An origin goes into a response header, so the database refuses anything but a plain https origin.
ALTER TABLE "tenant_embed_origins" ADD CONSTRAINT "tenant_embed_origins_shape_ck" CHECK ("origin" ~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$');--> statement-breakpoint
ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_hostname_shape_ck" CHECK ("hostname" = lower("hostname") AND "hostname" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$');--> statement-breakpoint
-- Which business serves this address. Only a live address (status active, records not missing for more than 7 days)
-- answers. The proxy asks this for every request on a host that is not Kalendr's own, and the certificate check asks
-- it before a certificate is issued, so both stop at the same moment.
CREATE OR REPLACE FUNCTION "kalendr_domain_lookup"(p_hostname text)
RETURNS TABLE (tenant_id text, slug text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $kalendr_domain_lookup$
  SELECT tenant.id, tenant.slug::text
  FROM tenant_domains AS domain
  JOIN tenants AS tenant ON tenant.id = domain.tenant_id AND tenant.is_active
  WHERE domain.hostname = lower(p_hostname)
    AND domain.status = 'active'
    AND domain.verified_at IS NOT NULL
    AND (domain.missing_since IS NULL OR domain.missing_since > now() - interval '7 days')
  LIMIT 1
$kalendr_domain_lookup$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_domain_lookup"(text) FROM PUBLIC;--> statement-breakpoint
-- The sites that may frame one business's booking page. The proxy reads this to build `frame-ancestors`.
CREATE OR REPLACE FUNCTION "kalendr_embed_origins"(p_slug text)
RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $kalendr_embed_origins$
  SELECT origin.origin::text
  FROM tenant_embed_origins AS origin
  JOIN tenants AS tenant ON tenant.id = origin.tenant_id AND tenant.is_active
  WHERE tenant.slug = lower(p_slug)
  ORDER BY origin.origin
  LIMIT 50
$kalendr_embed_origins$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_embed_origins"(text) FROM PUBLIC;--> statement-breakpoint
-- Claims an address for a business. The address is unique across all businesses, but a claim that was never
-- verified (failed, or past its 72 hours) must not block the rightful owner, so those are cleared first. Returns the
-- new id, or null when another business holds the address or this one already has it.
CREATE OR REPLACE FUNCTION "kalendr_claim_hostname"(p_tenant text, p_hostname text, p_token_hash text, p_check_until timestamptz)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $kalendr_claim_hostname$
DECLARE
  new_id text;
BEGIN
  DELETE FROM tenant_domains
  WHERE hostname = lower(p_hostname)
    AND tenant_id <> p_tenant
    AND status <> 'active'
    AND (status = 'failed' OR coalesce(check_until, created_at + interval '72 hours') < now());
  INSERT INTO tenant_domains (tenant_id, hostname, status, verification_token_hash, check_until)
  VALUES (p_tenant, lower(p_hostname), 'pending', p_token_hash, p_check_until)
  ON CONFLICT (hostname) DO NOTHING
  RETURNING id INTO new_id;
  RETURN new_id;
END
$kalendr_claim_hostname$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_claim_hostname"(text, text, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
-- Businesses with an address to look up now: a pending one not checked for 5 minutes (one past its 72 hours is looked at
-- once more and then marked failed), or a live one not checked for a day. Ids only. Worker role only.
CREATE OR REPLACE FUNCTION "kalendr_domain_tenants"()
RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $kalendr_domain_tenants$
  SELECT DISTINCT domain.tenant_id
  FROM tenant_domains AS domain
  WHERE (domain.status = 'pending' AND (domain.last_checked_at IS NULL OR domain.last_checked_at < now() - interval '5 minutes'))
     OR (domain.status = 'active' AND (domain.last_checked_at IS NULL OR domain.last_checked_at < now() - interval '1 day'))
$kalendr_domain_tenants$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_domain_tenants"() FROM PUBLIC;
