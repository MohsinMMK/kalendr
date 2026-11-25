CREATE TABLE "queue_counters" (
	"tenant_id" text NOT NULL,
	"location_id" text NOT NULL,
	"day" date NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "queue_counters_pk" PRIMARY KEY("tenant_id","location_id","day")
);
--> statement-breakpoint
CREATE TABLE "queue_tickets" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"location_id" text NOT NULL,
	"day" date NOT NULL,
	"number" integer NOT NULL,
	"appointment_id" text NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"urgent_reason" varchar(200),
	"urgent_by_user_id" text,
	"called_at" timestamp with time zone,
	"call_count" integer DEFAULT 0 NOT NULL,
	"skipped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_tickets_number_uq" UNIQUE("tenant_id","location_id","day","number"),
	CONSTRAINT "queue_tickets_appointment_uq" UNIQUE("tenant_id","appointment_id"),
	CONSTRAINT "queue_tickets_number_positive" CHECK ("queue_tickets"."number" > 0)
);
--> statement-breakpoint
ALTER TABLE "queue_counters" ADD CONSTRAINT "queue_counters_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_tickets" ADD CONSTRAINT "queue_tickets_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_tickets" ADD CONSTRAINT "queue_tickets_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "queue_tickets_day_idx" ON "queue_tickets" USING btree ("tenant_id","location_id","day");--> statement-breakpoint
ALTER TABLE "queue_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "queue_counters" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "queue_counters"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "queue_tickets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "queue_tickets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "queue_tickets"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
