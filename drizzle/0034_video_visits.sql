CREATE TABLE "video_rooms" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"provider" varchar(12) NOT NULL,
	"provider_room_name" varchar(120) NOT NULL,
	"room_url" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" varchar(10) DEFAULT 'active' NOT NULL,
	"staff_joined_at" timestamp with time zone,
	"staff_seen_at" timestamp with time zone,
	"customer_waiting_at" timestamp with time zone,
	"customer_admitted_at" timestamp with time zone,
	"customer_joined_at" timestamp with time zone,
	"customer_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_rooms_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "video_rooms_appointment_uq" UNIQUE("tenant_id","appointment_id"),
	CONSTRAINT "video_rooms_status_valid" CHECK ("video_rooms"."status" in ('active', 'ended'))
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "delivery_mode" varchar(10) DEFAULT 'in_person' NOT NULL;--> statement-breakpoint
ALTER TABLE "video_rooms" ADD CONSTRAINT "video_rooms_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_delivery_mode_valid" CHECK ("appointments"."delivery_mode" in ('in_person', 'video', 'phone'));--> statement-breakpoint
ALTER TABLE "video_rooms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "video_rooms" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "video_rooms" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
-- Businesses already on the standard set (migration 0030) also get the video link reminder, which only
-- applies to video visits. The words match src/lib/workflow-presets.ts.
INSERT INTO "workflows" ("tenant_id", "name", "trigger", "offset_minutes", "filters", "preset_key")
SELECT settings.tenant_id, 'Send the video link', 'before_start', 60,
  '{"serviceIds": [], "locationIds": [], "practitionerIds": [], "bookingSources": [], "deliveryModes": ["video"]}'::jsonb, 'video_link'
FROM "workflow_settings" AS settings
WHERE settings.presets_applied_at IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "workflow_steps" ("tenant_id", "workflow_id", "position", "channel", "subject", "body")
SELECT workflow.tenant_id, workflow.id, 0, 'email', 'Your video visit at {time}: join link inside',
  E'Hi {customer_first_name},\n\nYour video visit with {staff_name} is at {time} on {date}.\n\nJoin here, from 15 minutes before: {join_link}\n\nTry your camera and microphone first: {camera_test_link}'
FROM "workflows" AS workflow
WHERE workflow.preset_key = 'video_link'
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "workflow_settings" SET "reconciled_at" = NULL WHERE "presets_applied_at" IS NOT NULL;
