-- Feature 39: booking page 2.0. Layouts, timezone lock and week start per service, the business's clock
-- default and week start, and short slot holds so a time stays with the customer while they fill in the form.
-- Written by hand like 0025 to 0032 (drizzle-kit's prompts need a terminal).
ALTER TABLE "services" ADD COLUMN "layouts_enabled" text[] DEFAULT ARRAY['month','week','column']::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "default_layout" varchar(8) DEFAULT 'month' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "lock_timezone" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "week_start" smallint;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_layouts_valid" CHECK ("layouts_enabled" <@ ARRAY['month','week','column']::text[] AND cardinality("layouts_enabled") > 0 AND "default_layout" = ANY("layouts_enabled"));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_week_start_valid" CHECK ("week_start" IS NULL OR "week_start" IN (1, 7));--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "default_clock" varchar(4) DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "week_start" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_default_clock_valid" CHECK ("default_clock" IN ('auto','12h','24h'));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_week_start_valid" CHECK ("week_start" IN (1, 7));--> statement-breakpoint
CREATE TABLE "slot_holds" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"service_id" text NOT NULL,
	"practitioner_id" text NOT NULL,
	"location_id" text NOT NULL,
	"resource_id" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	-- The visit plus its buffers: the time nobody else may take while the hold lives.
	"reserved_starts_at" timestamp with time zone NOT NULL,
	"reserved_ends_at" timestamp with time zone NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	-- 'booking' while a customer fills in the form; feature 23 adds 'payment' for a held place awaiting payment.
	"purpose" varchar(16) DEFAULT 'booking' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slot_holds_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "slot_holds_token_uq" UNIQUE("token_hash"),
	CONSTRAINT "slot_holds_time_order" CHECK ("ends_at" > "starts_at" AND "reserved_ends_at" >= "reserved_starts_at"),
	CONSTRAINT "slot_holds_purpose_valid" CHECK ("purpose" IN ('booking','payment'))
);--> statement-breakpoint
ALTER TABLE "slot_holds" ADD CONSTRAINT "slot_holds_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_holds" ADD CONSTRAINT "slot_holds_practitioner_fk" FOREIGN KEY ("tenant_id","practitioner_id") REFERENCES "public"."practitioners"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_holds" ADD CONSTRAINT "slot_holds_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_holds" ADD CONSTRAINT "slot_holds_resource_fk" FOREIGN KEY ("tenant_id","resource_id") REFERENCES "public"."resources"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slot_holds_person_expiry_idx" ON "slot_holds" USING btree ("tenant_id","practitioner_id","expires_at");--> statement-breakpoint
CREATE INDEX "slot_holds_expiry_idx" ON "slot_holds" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "slot_holds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "slot_holds" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "slot_holds" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
