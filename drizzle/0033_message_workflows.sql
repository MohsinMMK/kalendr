CREATE TABLE "scheduled_messages" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"step_id" text NOT NULL,
	"slot_key" varchar(80) NOT NULL,
	"appointment_version" integer NOT NULL,
	"send_at" timestamp with time zone NOT NULL,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"reason" varchar(40),
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_messages_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "scheduled_messages_slot_uq" UNIQUE("tenant_id","appointment_id","step_id","slot_key"),
	CONSTRAINT "scheduled_messages_status_valid" CHECK ("scheduled_messages"."status" in ('pending', 'queued', 'sent', 'skipped', 'cancelled', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "workflow_settings" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"quiet_start_minute" smallint DEFAULT 1260 NOT NULL,
	"quiet_end_minute" smallint DEFAULT 480 NOT NULL,
	"presets_applied_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_settings_minutes_valid" CHECK ("workflow_settings"."quiet_start_minute" between 0 and 1439 and "workflow_settings"."quiet_end_minute" between 0 and 1439)
);
--> statement-breakpoint
CREATE TABLE "workflow_steps" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"position" smallint NOT NULL,
	"channel" varchar(24) NOT NULL,
	"subject" varchar(200) DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"template_key" varchar(40),
	"wait_minutes" integer DEFAULT 0 NOT NULL,
	"ignore_quiet_hours" boolean DEFAULT false NOT NULL,
	"skip_if_confirmed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_steps_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "workflow_steps_position_uq" UNIQUE("tenant_id","workflow_id","position"),
	CONSTRAINT "workflow_steps_wait_range" CHECK ("workflow_steps"."wait_minutes" between 0 and 86400),
	CONSTRAINT "workflow_steps_body_length" CHECK (char_length("workflow_steps"."body") <= 2000 and (char_length("workflow_steps"."body") >= 1 or "workflow_steps"."template_key" is not null))
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"name" varchar(160) NOT NULL,
	"trigger" varchar(24) NOT NULL,
	"offset_minutes" integer DEFAULT 0 NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"preset_key" varchar(40),
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflows_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "workflows_trigger_valid" CHECK ("workflows"."trigger" in ('booked', 'requested', 'rescheduled', 'cancelled', 'before_start', 'after_end', 'no_show', 'form_missing', 'checked_in')),
	CONSTRAINT "workflows_offset_range" CHECK ("workflows"."offset_minutes" between 0 and 86400)
);
--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_step_fk" FOREIGN KEY ("tenant_id","step_id") REFERENCES "public"."workflow_steps"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_settings" ADD CONSTRAINT "workflow_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_workflow_fk" FOREIGN KEY ("tenant_id","workflow_id") REFERENCES "public"."workflows"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_messages_due_idx" ON "scheduled_messages" USING btree ("status","send_at");--> statement-breakpoint
CREATE INDEX "scheduled_messages_appointment_idx" ON "scheduled_messages" USING btree ("tenant_id","appointment_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_tenant_preset_uq" ON "workflows" USING btree ("tenant_id","preset_key") WHERE "workflows"."preset_key" is not null;--> statement-breakpoint
CREATE INDEX "workflows_tenant_active_idx" ON "workflows" USING btree ("tenant_id","active","trigger");--> statement-breakpoint
-- Row-level security: every workflow table is limited to the business in app.tenant_id.
ALTER TABLE "workflow_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workflow_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "workflow_settings" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "workflows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workflows" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "workflows" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "workflow_steps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workflow_steps" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "workflow_steps" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "scheduled_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scheduled_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "scheduled_messages" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
-- The worker's way to find businesses with workflow work, like kalendr_worker_tenants: ids only.
-- workflow_sweep: a message is due. workflow_reconcile: workflows changed since the last full pass.
CREATE OR REPLACE FUNCTION "kalendr_workflow_tenants"("p_job" text)
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_workflow_tenants$
  SELECT DISTINCT message.tenant_id
  FROM public.scheduled_messages AS message
  WHERE p_job = 'workflow_sweep' AND message.status = 'pending' AND message.send_at <= now()
  UNION
  SELECT settings.tenant_id
  FROM public.workflow_settings AS settings
  WHERE p_job = 'workflow_reconcile' AND settings.reconciled_at IS NULL
$kalendr_workflow_tenants$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_workflow_tenants"(text) FROM PUBLIC;--> statement-breakpoint
-- Every business that exists today starts with the standard set, so reminders keep going out after the
-- fixed 24-hour reminder stands down. The words match src/lib/workflow-presets.ts; owners edit from here.
INSERT INTO "workflow_settings" ("tenant_id", "presets_applied_at") SELECT id, now() FROM "tenants" ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "workflows" ("tenant_id", "name", "trigger", "offset_minutes", "preset_key")
SELECT tenant.id, preset.name, preset.trigger, preset.offset_minutes, preset.preset_key
FROM "tenants" AS tenant
CROSS JOIN (VALUES
  ('Reminder 24 hours before', 'before_start', 1440, 'reminder_24h'),
  ('Reminder 2 hours before', 'before_start', 120, 'reminder_2h'),
  ('Ask for a review', 'after_end', 120, 'review_request')
) AS preset(name, trigger, offset_minutes, preset_key)
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "workflow_steps" ("tenant_id", "workflow_id", "position", "channel", "subject", "body")
SELECT workflow.tenant_id, workflow.id, 0, 'email',
  CASE workflow.preset_key
    WHEN 'reminder_24h' THEN 'Reminder: {service} on {date} at {time}'
    WHEN 'reminder_2h' THEN 'Today at {time}: {service}'
    ELSE 'How was your visit with {business_name}?' END,
  CASE workflow.preset_key
    WHEN 'reminder_24h' THEN E'Hi {customer_first_name},\n\nThis is a reminder from {business_name}: {service} with {staff_name} on {date} at {time}, {location}.\n\nIf you can no longer make it, please change or cancel so someone else can have the time: {manage_link}'
    WHEN 'reminder_2h' THEN E'Hi {customer_first_name},\n\nSee you soon: {service} with {staff_name} at {time}, {location}.\n\nChange or cancel: {manage_link}'
    ELSE E'Hi {customer_first_name},\n\nThanks for visiting {business_name}. A quick rating helps them, and helps others choose.\n\nLeave a review: {manage_link}' END
FROM "workflows" AS workflow
WHERE workflow.preset_key IN ('reminder_24h', 'reminder_2h', 'review_request')
ON CONFLICT DO NOTHING;
