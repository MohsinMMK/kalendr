CREATE TABLE "booking_short_links" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"code" varchar(7) NOT NULL,
	"label" varchar(80) NOT NULL,
	"target_path" varchar(600) NOT NULL,
	"created_by_user_id" text,
	"clicks" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_short_links_code_uq" UNIQUE("code"),
	CONSTRAINT "booking_short_links_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "booking_short_links_code_ck" CHECK ("booking_short_links"."code" ~ '^[a-z2-9]{7}$'),
	CONSTRAINT "booking_short_links_path_ck" CHECK ("booking_short_links"."target_path" ~ '^/book/[a-z0-9-]+(/[a-z0-9-]+)?(\?.*)?$')
);
--> statement-breakpoint
CREATE TABLE "tracking_settings" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"google_analytics_id" varchar(24),
	"tag_manager_id" varchar(20),
	"meta_pixel_id" varchar(20),
	"plausible_domain" varchar(120),
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracking_settings_ga_ck" CHECK ("tracking_settings"."google_analytics_id" is null or "tracking_settings"."google_analytics_id" ~ '^(G|UA|AW)-[A-Z0-9-]{4,20}$'),
	CONSTRAINT "tracking_settings_gtm_ck" CHECK ("tracking_settings"."tag_manager_id" is null or "tracking_settings"."tag_manager_id" ~ '^GTM-[A-Z0-9]{4,12}$'),
	CONSTRAINT "tracking_settings_meta_ck" CHECK ("tracking_settings"."meta_pixel_id" is null or "tracking_settings"."meta_pixel_id" ~ '^[0-9]{8,20}$'),
	CONSTRAINT "tracking_settings_plausible_ck" CHECK ("tracking_settings"."plausible_domain" is null or "tracking_settings"."plausible_domain" ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$')
);
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "after_booking" varchar(14) DEFAULT 'kalendr_page' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "redirect_url" varchar(500);--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "pass_details_on_redirect" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "success_message" varchar(500);--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "hide_success_details" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_short_links" ADD CONSTRAINT "booking_short_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_settings" ADD CONSTRAINT "tracking_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_short_links_tenant_idx" ON "booking_short_links" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_after_booking_valid" CHECK ("services"."after_booking" in ('kalendr_page', 'redirect') and ("services"."after_booking" <> 'redirect' or "services"."redirect_url" is not null));
--> statement-breakpoint
-- Feature 52, the hand-written part: row-level security on both new tables (the policy every business table has), the
-- link lookup the public /s/<code> route uses, and a check that an after-booking redirect leaves the choice of target to the owner.
ALTER TABLE "booking_short_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_short_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking_short_links"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "tracking_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tracking_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tracking_settings"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
-- A printed link carries only a code. This counts the visit and returns the page to open, nothing else: no address,
-- no visitor detail. A paused business or a switched-off link returns nothing.
CREATE OR REPLACE FUNCTION "kalendr_follow_booking_link"("p_code" text)
RETURNS text
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_follow_booking_link$
  WITH followed AS (
    UPDATE public.booking_short_links AS link
    SET clicks = link.clicks + 1
    FROM public.tenants AS tenant
    WHERE link.code = p_code AND link.is_active AND tenant.id = link.tenant_id AND tenant.is_active AND tenant.paused_at IS NULL
    RETURNING link.target_path
  )
  SELECT target_path FROM followed LIMIT 1
$kalendr_follow_booking_link$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_follow_booking_link"(text) FROM PUBLIC;
