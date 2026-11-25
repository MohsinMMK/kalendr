-- Feature 38: booking limits. Caps on bookings or booked minutes per day, week, month or year for a
-- service, person, branch, room or hand-picked team, plus per-customer caps and "first slot only" on services.
-- Written by hand like 0025 to 0031 (drizzle-kit's prompts need a terminal).
CREATE TABLE "limit_teams" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"name" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "limit_teams_tenant_id_id_uq" UNIQUE("tenant_id","id")
);--> statement-breakpoint
CREATE TABLE "limit_team_members" (
	"tenant_id" text NOT NULL,
	"team_id" text NOT NULL,
	"practitioner_id" text NOT NULL,
	CONSTRAINT "limit_team_members_pk" PRIMARY KEY("tenant_id","team_id","practitioner_id")
);--> statement-breakpoint
CREATE TABLE "booking_limits" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"scope" varchar(16) NOT NULL,
	"service_id" text,
	"practitioner_id" text,
	"location_id" text,
	"resource_id" text,
	"team_id" text,
	"measure" varchar(8) NOT NULL,
	"period" varchar(8) NOT NULL,
	"max_value" integer NOT NULL,
	"week_start" smallint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_limits_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "booking_limits_scope_valid" CHECK ("scope" IN ('service','practitioner','location','resource','team')),
	CONSTRAINT "booking_limits_measure_valid" CHECK ("measure" IN ('count','minutes')),
	CONSTRAINT "booking_limits_period_valid" CHECK ("period" IN ('day','week','month','year')),
	CONSTRAINT "booking_limits_max_positive" CHECK ("max_value" > 0),
	CONSTRAINT "booking_limits_week_start_valid" CHECK ("week_start" IN (1, 7)),
	-- Exactly the column that names the scope is set.
	CONSTRAINT "booking_limits_one_owner" CHECK (
		(("scope" = 'service') AND "service_id" IS NOT NULL AND "practitioner_id" IS NULL AND "location_id" IS NULL AND "resource_id" IS NULL AND "team_id" IS NULL) OR
		(("scope" = 'practitioner') AND "practitioner_id" IS NOT NULL AND "service_id" IS NULL AND "location_id" IS NULL AND "resource_id" IS NULL AND "team_id" IS NULL) OR
		(("scope" = 'location') AND "location_id" IS NOT NULL AND "service_id" IS NULL AND "practitioner_id" IS NULL AND "resource_id" IS NULL AND "team_id" IS NULL) OR
		(("scope" = 'resource') AND "resource_id" IS NOT NULL AND "service_id" IS NULL AND "practitioner_id" IS NULL AND "location_id" IS NULL AND "team_id" IS NULL) OR
		(("scope" = 'team') AND "team_id" IS NOT NULL AND "service_id" IS NULL AND "practitioner_id" IS NULL AND "location_id" IS NULL AND "resource_id" IS NULL)
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX "booking_limits_one_per_kind_uq" ON "booking_limits" USING btree ("tenant_id","scope",(coalesce("service_id","practitioner_id","location_id","resource_id","team_id")),"measure","period");--> statement-breakpoint
ALTER TABLE "limit_team_members" ADD CONSTRAINT "limit_team_members_team_fk" FOREIGN KEY ("tenant_id","team_id") REFERENCES "public"."limit_teams"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limit_team_members" ADD CONSTRAINT "limit_team_members_practitioner_fk" FOREIGN KEY ("tenant_id","practitioner_id") REFERENCES "public"."practitioners"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_limits" ADD CONSTRAINT "booking_limits_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_limits" ADD CONSTRAINT "booking_limits_practitioner_fk" FOREIGN KEY ("tenant_id","practitioner_id") REFERENCES "public"."practitioners"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_limits" ADD CONSTRAINT "booking_limits_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_limits" ADD CONSTRAINT "booking_limits_resource_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."resources"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_limits" ADD CONSTRAINT "booking_limits_team_fk" FOREIGN KEY ("tenant_id","team_id") REFERENCES "public"."limit_teams"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_limits_tenant_scope_idx" ON "booking_limits" USING btree ("tenant_id","scope");--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "max_active_per_customer" smallint;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "offer_reschedule_when_capped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "first_slot_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_max_active_positive" CHECK ("max_active_per_customer" IS NULL OR "max_active_per_customer" > 0);--> statement-breakpoint
-- Counting a day's bookings for one person or room reads appointments by start time.
CREATE INDEX IF NOT EXISTS "appointments_tenant_service_start_idx" ON "appointments" USING btree ("tenant_id","service_id","starts_at");--> statement-breakpoint
ALTER TABLE "limit_teams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "limit_teams" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "limit_teams" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "limit_team_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "limit_team_members" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "limit_team_members" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "booking_limits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_limits" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking_limits" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
