CREATE TABLE "combined_links" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"slug" varchar(60) NOT NULL,
	"label" varchar(80) NOT NULL,
	"service_id" text NOT NULL,
	"practitioner_ids" text[] NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "combined_links_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "combined_links_people_ck" CHECK (cardinality("combined_links"."practitioner_ids") between 2 and 4),
	CONSTRAINT "combined_links_slug_ck" CHECK ("combined_links"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "special_links" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"service_id" text NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"label" varchar(80) NOT NULL,
	"kind" varchar(10) NOT NULL,
	"max_uses" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "special_links_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "special_links_kind_valid" CHECK ("special_links"."kind" in ('single_use', 'limited', 'expiring')),
	CONSTRAINT "special_links_shape_ck" CHECK (("special_links"."kind" = 'single_use' and "special_links"."max_uses" = 1)
    or ("special_links"."kind" = 'limited' and "special_links"."max_uses" between 2 and 1000)
    or ("special_links"."kind" = 'expiring' and "special_links"."max_uses" is null and "special_links"."expires_at" is not null)),
	CONSTRAINT "special_links_used_ck" CHECK ("special_links"."used_count" >= 0 and ("special_links"."max_uses" is null or "special_links"."used_count" <= "special_links"."max_uses"))
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "special_link_id" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "group_ref" text;--> statement-breakpoint
ALTER TABLE "combined_links" ADD CONSTRAINT "combined_links_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "special_links" ADD CONSTRAINT "special_links_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "combined_links_slug_uq" ON "combined_links" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "special_links_token_hash_uq" ON "special_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "special_links_service_idx" ON "special_links" USING btree ("tenant_id","service_id","created_at");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_special_link_fk" FOREIGN KEY ("tenant_id","special_link_id") REFERENCES "public"."special_links"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_special_link_idx" ON "appointments" USING btree ("tenant_id","special_link_id") WHERE "appointments"."special_link_id" is not null;--> statement-breakpoint
CREATE INDEX "appointments_group_ref_idx" ON "appointments" USING btree ("tenant_id","group_ref") WHERE "appointments"."group_ref" is not null;
--> statement-breakpoint
-- Feature 45, the hand-written part: forced row-level security on the two new tables.
ALTER TABLE "special_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "special_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "special_links"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "combined_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "combined_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "combined_links"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
-- A visitor arrives with a token and no business: this finds the business and the link by the token's hash, the way
-- kalendr_resolve_manage_token does for a booking link. It returns ids only; the page then reads the rest inside the business.
CREATE OR REPLACE FUNCTION "kalendr_resolve_special_link"(p_token_hash text)
RETURNS TABLE (tenant_id text, link_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_resolve_special_link$
  SELECT link.tenant_id, link.id FROM special_links AS link WHERE link.token_hash = p_token_hash LIMIT 1
$kalendr_resolve_special_link$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_special_link"(text) FROM PUBLIC;
