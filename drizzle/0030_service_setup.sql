-- Feature 36: service setup 2.0. Timing, lengths and prices, where a service happens, and its look.
-- Written by hand, like 0025: drizzle-kit's prompts need a terminal and the 0025 snapshot is missing.
ALTER TABLE "services" ALTER COLUMN "slot_interval_minutes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "booking_window_kind" varchar(16) DEFAULT 'rolling_days' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "booking_window_from" date;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "booking_window_through" date;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "start_offset_minutes" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "color_light" varchar(20);--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "color_dark" varchar(20);--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "visibility" varchar(8) DEFAULT 'listed' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "slug" varchar(80) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "banner_media_id" text;--> statement-breakpoint
-- A link-safe name for every service that exists. Two services with the same name get -2, -3 and so on.
WITH base AS (
  SELECT id, tenant_id, created_at,
    coalesce(nullif(trim(both '-' from left(regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g'), 70)), ''), 'service') AS stem
  FROM "services"
), ranked AS (
  SELECT id, stem, row_number() OVER (PARTITION BY tenant_id, stem ORDER BY created_at, id) AS position
  FROM base
)
UPDATE "services" AS service
SET "slug" = CASE WHEN ranked.position = 1 THEN ranked.stem ELSE ranked.stem || '-' || ranked.position END
FROM ranked WHERE ranked.id = service.id;--> statement-breakpoint
-- A new service that arrives without a link name (older code paths, seed scripts) gets one from its name.
CREATE OR REPLACE FUNCTION "kalendr_service_slug"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  stem text;
  candidate text;
  suffix integer := 1;
BEGIN
  IF NEW.slug IS NOT NULL AND NEW.slug <> '' THEN RETURN NEW; END IF;
  stem := coalesce(nullif(trim(both '-' from left(regexp_replace(lower(NEW.name), '[^a-z0-9]+', '-', 'g'), 70)), ''), 'service');
  candidate := stem;
  WHILE EXISTS (SELECT 1 FROM services WHERE tenant_id = NEW.tenant_id AND slug = candidate) LOOP
    suffix := suffix + 1;
    candidate := stem || '-' || suffix;
  END LOOP;
  NEW.slug := candidate;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "services_fill_slug" BEFORE INSERT ON "services"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_service_slug"();--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_tenant_slug_uq" UNIQUE("tenant_id","slug");--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_buffers_range" CHECK ("services"."buffer_before_minutes" between 0 and 240 and "services"."buffer_after_minutes" between 0 and 240);--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_offset_below_interval" CHECK ("services"."start_offset_minutes" >= 0 and "services"."start_offset_minutes" < "services"."slot_interval_minutes");--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_notice_range" CHECK ("services"."minimum_lead_minutes" between 0 and 129600);--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_window_kind_valid" CHECK ("services"."booking_window_kind" in ('rolling_days', 'business_days', 'date_range'));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_window_dates_ordered" CHECK ("services"."booking_window_kind" <> 'date_range' or ("services"."booking_window_from" is not null and "services"."booking_window_through" is not null and "services"."booking_window_through" >= "services"."booking_window_from"));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_visibility_valid" CHECK ("services"."visibility" in ('listed', 'hidden'));--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "location_kind" varchar(16);--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "location_detail" text;--> statement-breakpoint
CREATE TABLE "service_durations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"service_id" text NOT NULL,
	"minutes" smallint NOT NULL,
	"price_minor" integer,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_durations_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_durations_service_minutes_uq" UNIQUE("tenant_id","service_id","minutes"),
	CONSTRAINT "service_durations_minutes_range" CHECK ("service_durations"."minutes" between 5 and 480),
	CONSTRAINT "service_durations_price_not_negative" CHECK ("service_durations"."price_minor" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "service_durations_one_default_uq" ON "service_durations" USING btree ("tenant_id","service_id") WHERE "service_durations"."is_default";--> statement-breakpoint
ALTER TABLE "service_durations" ADD CONSTRAINT "service_durations_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "service_location_options" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"service_id" text NOT NULL,
	"kind" varchar(16) NOT NULL,
	"location_id" text,
	"note" varchar(200),
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_location_options_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_location_options_kind_valid" CHECK ("service_location_options"."kind" in ('in_person', 'we_call', 'they_call', 'video', 'their_address')),
	CONSTRAINT "service_location_options_branch_matches_kind" CHECK (("service_location_options"."kind" = 'in_person') = ("service_location_options"."location_id" is not null))
);--> statement-breakpoint
CREATE UNIQUE INDEX "service_location_options_unique_idx" ON "service_location_options" USING btree ("tenant_id","service_id","kind",coalesce("location_id", ''));--> statement-breakpoint
ALTER TABLE "service_location_options" ADD CONSTRAINT "service_location_options_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_location_options" ADD CONSTRAINT "service_location_options_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_durations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "service_durations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "service_durations"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "service_location_options" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "service_location_options" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "service_location_options"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
-- Every service keeps its current length and price as its default length, so nothing changes for existing services.
INSERT INTO "service_durations" ("tenant_id", "service_id", "minutes", "price_minor", "is_default", "sort_order")
SELECT "tenant_id", "id", "duration_minutes", "price_minor", true, 0 FROM "services";--> statement-breakpoint
-- Every service is offered in person at each branch it already lists.
INSERT INTO "service_location_options" ("tenant_id", "service_id", "kind", "location_id", "sort_order")
SELECT "tenant_id", "service_id", 'in_person', "location_id", 0 FROM "service_locations";
