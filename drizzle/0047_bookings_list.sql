CREATE TABLE "appointment_host_no_shows" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"practitioner_id" text NOT NULL,
	"marked_by_user_id" text,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_host_no_shows_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "appointment_host_no_shows_appointment_uq" UNIQUE("tenant_id","appointment_id")
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_membership_id" text NOT NULL,
	"name" varchar(80) NOT NULL,
	"page" varchar(16) DEFAULT 'bookings' NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort" varchar(8) DEFAULT 'asc' NOT NULL,
	"columns" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_views_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "saved_views_owner_name_uq" UNIQUE("tenant_id","owner_membership_id","page","name"),
	CONSTRAINT "saved_views_page_valid" CHECK ("saved_views"."page" in ('bookings')),
	CONSTRAINT "saved_views_sort_valid" CHECK ("saved_views"."sort" in ('asc', 'desc'))
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "customer_no_show_marked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointment_host_no_shows" ADD CONSTRAINT "host_no_shows_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_host_no_shows" ADD CONSTRAINT "host_no_shows_practitioner_fk" FOREIGN KEY ("tenant_id","practitioner_id") REFERENCES "public"."practitioners"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_owner_fk" FOREIGN KEY ("tenant_id","owner_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "host_no_shows_person_idx" ON "appointment_host_no_shows" USING btree ("tenant_id","practitioner_id","marked_at");--> statement-breakpoint
CREATE INDEX "saved_views_lookup_idx" ON "saved_views" USING btree ("tenant_id","page","shared");--> statement-breakpoint
CREATE INDEX "appointments_list_idx" ON "appointments" USING btree ("tenant_id","starts_at","id");--> statement-breakpoint
CREATE INDEX "appointments_list_status_idx" ON "appointments" USING btree ("tenant_id","status","starts_at","id");--> statement-breakpoint
CREATE INDEX "appointments_list_person_idx" ON "appointments" USING btree ("tenant_id","practitioner_id","starts_at","id");--> statement-breakpoint
CREATE INDEX "appointments_list_service_idx" ON "appointments" USING btree ("tenant_id","service_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_list_customer_idx" ON "appointments" USING btree ("tenant_id","patient_id","starts_at");
--> statement-breakpoint
ALTER TABLE "saved_views" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "saved_views" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "saved_views" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "appointment_host_no_shows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appointment_host_no_shows" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appointment_host_no_shows" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
