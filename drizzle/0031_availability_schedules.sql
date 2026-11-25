-- Feature 37: availability 2.0. Named schedules, date overrides, public holiday settings, travel
-- periods and out of office. Written by hand, like 0025 and 0026 (drizzle-kit's prompts need a terminal).
CREATE TABLE "availability_schedules" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"practitioner_id" text NOT NULL,
	"name" varchar(80) NOT NULL,
	"timezone" varchar(64) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_schedules_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "availability_schedules_person_name_uq" UNIQUE("tenant_id","practitioner_id","name"),
	CONSTRAINT "availability_schedules_version_positive" CHECK ("version" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "availability_schedules_one_default_uq" ON "availability_schedules" USING btree ("tenant_id","practitioner_id") WHERE "is_default";--> statement-breakpoint
ALTER TABLE "availability_schedules" ADD CONSTRAINT "availability_schedules_practitioner_fk" FOREIGN KEY ("tenant_id","practitioner_id") REFERENCES "public"."practitioners"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Every person who has working hours today gets one default schedule, "Working hours", holding them.
INSERT INTO "availability_schedules" ("tenant_id", "practitioner_id", "name", "timezone", "is_default")
SELECT "tenant_id", "practitioner_id", 'Working hours', min("timezone"), true FROM "availability_rules" GROUP BY "tenant_id", "practitioner_id";--> statement-breakpoint
ALTER TABLE "availability_rules" ADD COLUMN "schedule_id" text;--> statement-breakpoint
UPDATE "availability_rules" AS rule SET "schedule_id" = schedule."id"
FROM "availability_schedules" AS schedule
WHERE schedule."tenant_id" = rule."tenant_id" AND schedule."practitioner_id" = rule."practitioner_id" AND schedule."is_default";--> statement-breakpoint
ALTER TABLE "availability_rules" ALTER COLUMN "schedule_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_schedule_fk" FOREIGN KEY ("tenant_id","schedule_id") REFERENCES "public"."availability_schedules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Code that still inserts a rule without naming a schedule (older paths, seed scripts) lands in the person's default one,
-- which is made on the spot when they have none.
CREATE OR REPLACE FUNCTION "kalendr_rule_default_schedule"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  chosen text;
BEGIN
  IF NEW.schedule_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT id INTO chosen FROM availability_schedules
    WHERE tenant_id = NEW.tenant_id AND practitioner_id = NEW.practitioner_id AND is_default;
  IF chosen IS NULL THEN
    INSERT INTO availability_schedules (tenant_id, practitioner_id, name, timezone, is_default)
    VALUES (NEW.tenant_id, NEW.practitioner_id, 'Working hours', NEW.timezone, true)
    RETURNING id INTO chosen;
  END IF;
  NEW.schedule_id := chosen;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "availability_rules_default_schedule" BEFORE INSERT ON "availability_rules"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_rule_default_schedule"();--> statement-breakpoint
-- Older versions allowed overlapping rules, which the constraint below forbids. Before adding it, retire the overlaps.
-- First pass, which loses no hours: a rule whose times and dates sit wholly inside another active rule of the same
-- schedule, place and weekday is switched off. Of two identical rules, the earlier-made one stays.
UPDATE "availability_rules" AS inner_rule SET "is_active" = false, "updated_at" = now()
WHERE inner_rule."is_active" AND EXISTS (
  SELECT 1 FROM "availability_rules" AS outer_rule
  WHERE outer_rule."is_active" AND outer_rule."id" <> inner_rule."id"
    AND outer_rule."tenant_id" = inner_rule."tenant_id" AND outer_rule."schedule_id" = inner_rule."schedule_id"
    AND outer_rule."location_id" = inner_rule."location_id" AND outer_rule."day_of_week" = inner_rule."day_of_week"
    AND outer_rule."starts_at_local" <= inner_rule."starts_at_local" AND outer_rule."ends_at_local" >= inner_rule."ends_at_local"
    AND daterange(outer_rule."valid_from", coalesce(outer_rule."valid_through", 'infinity'::date), '[]')
        @> daterange(inner_rule."valid_from", coalesce(inner_rule."valid_through", 'infinity'::date), '[]')
    AND (
      outer_rule."starts_at_local" <> inner_rule."starts_at_local" OR outer_rule."ends_at_local" <> inner_rule."ends_at_local"
      OR outer_rule."valid_from" <> inner_rule."valid_from"
      OR coalesce(outer_rule."valid_through", 'infinity'::date) <> coalesce(inner_rule."valid_through", 'infinity'::date)
      OR (outer_rule."created_at", outer_rule."id") < (inner_rule."created_at", inner_rule."id")
    )
);--> statement-breakpoint
-- Second pass, for the rare partial overlaps left: the earliest-made rule of each overlapping pair stays active.
UPDATE "availability_rules" AS newer SET "is_active" = false, "updated_at" = now()
WHERE newer."is_active" AND EXISTS (
  SELECT 1 FROM "availability_rules" AS older
  WHERE older."is_active" AND older."id" <> newer."id"
    AND older."tenant_id" = newer."tenant_id" AND older."schedule_id" = newer."schedule_id"
    AND older."location_id" = newer."location_id" AND older."day_of_week" = newer."day_of_week"
    AND (older."created_at", older."id") < (newer."created_at", newer."id")
    AND tsrange(('2000-01-01'::date + older."starts_at_local"), ('2000-01-01'::date + older."ends_at_local"))
        && tsrange(('2000-01-01'::date + newer."starts_at_local"), ('2000-01-01'::date + newer."ends_at_local"))
    AND daterange(older."valid_from", coalesce(older."valid_through", 'infinity'::date), '[]')
        && daterange(newer."valid_from", coalesce(newer."valid_through", 'infinity'::date), '[]')
);--> statement-breakpoint
-- Two ranges of one schedule may not overlap on the same weekday at the same place while both are in force.
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_no_overlap" EXCLUDE USING gist (
  "schedule_id" WITH =,
  "location_id" WITH =,
  "day_of_week" WITH =,
  tsrange(('2000-01-01'::date + "starts_at_local"), ('2000-01-01'::date + "ends_at_local")) WITH &&,
  daterange("valid_from", coalesce("valid_through", 'infinity'::date), '[]') WITH &&
) WHERE ("is_active");--> statement-breakpoint
CREATE TABLE "availability_overrides" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"schedule_id" text NOT NULL,
	"date" date NOT NULL,
	"ranges" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_overrides_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "availability_overrides_schedule_date_uq" UNIQUE("tenant_id","schedule_id","date"),
	CONSTRAINT "availability_overrides_ranges_shape" CHECK ("ranges" is null or jsonb_typeof("ranges") = 'array')
);--> statement-breakpoint
ALTER TABLE "availability_overrides" ADD CONSTRAINT "availability_overrides_schedule_fk" FOREIGN KEY ("tenant_id","schedule_id") REFERENCES "public"."availability_schedules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "holiday_settings" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"country" varchar(2) NOT NULL,
	"region" varchar(10),
	"opted_out" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"custom_days" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holiday_settings_opted_out_shape" CHECK (jsonb_typeof("opted_out") = 'object'),
	CONSTRAINT "holiday_settings_custom_shape" CHECK (jsonb_typeof("custom_days") = 'array')
);--> statement-breakpoint
ALTER TABLE "holiday_settings" ADD CONSTRAINT "holiday_settings_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "travel_periods" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"practitioner_id" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"timezone" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "travel_periods_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "travel_periods_dates_ordered" CHECK ("ends_on" >= "starts_on"),
	CONSTRAINT "travel_periods_no_overlap" EXCLUDE USING gist ("tenant_id" WITH =, "practitioner_id" WITH =, daterange("starts_on", "ends_on", '[]') WITH &&)
);--> statement-breakpoint
ALTER TABLE "travel_periods" ADD CONSTRAINT "travel_periods_practitioner_fk" FOREIGN KEY ("tenant_id","practitioner_id") REFERENCES "public"."practitioners"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Feature 20 shares this table: it adds its own routing on top of the same columns.
CREATE TABLE "time_off" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"practitioner_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" varchar(16) DEFAULT 'leave' NOT NULL,
	"public_note" varchar(200),
	"cover_practitioner_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_off_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "time_off_time_order" CHECK ("ends_at" > "starts_at"),
	CONSTRAINT "time_off_reason_valid" CHECK ("reason" in ('leave', 'sick', 'training', 'holiday', 'other')),
	CONSTRAINT "time_off_cover_is_someone_else" CHECK ("cover_practitioner_id" is null or "cover_practitioner_id" <> "practitioner_id")
);--> statement-breakpoint
CREATE INDEX "time_off_lookup_idx" ON "time_off" USING btree ("tenant_id","practitioner_id","starts_at");--> statement-breakpoint
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_practitioner_fk" FOREIGN KEY ("tenant_id","practitioner_id") REFERENCES "public"."practitioners"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_cover_fk" FOREIGN KEY ("tenant_id","cover_practitioner_id") REFERENCES "public"."practitioners"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "schedule_id" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "restriction_schedule_id" text;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_schedule_fk" FOREIGN KEY ("tenant_id","schedule_id") REFERENCES "public"."availability_schedules"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_restriction_schedule_fk" FOREIGN KEY ("tenant_id","restriction_schedule_id") REFERENCES "public"."availability_schedules"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_schedules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "availability_schedules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "availability_schedules" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "availability_overrides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "availability_overrides" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "availability_overrides" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "holiday_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "holiday_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "holiday_settings" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "travel_periods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "travel_periods" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "travel_periods" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "time_off" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "time_off" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "time_off" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
