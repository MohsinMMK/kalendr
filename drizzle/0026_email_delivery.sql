CREATE TABLE "message_delivery_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"provider" varchar(24) NOT NULL,
	"provider_event_id" varchar(120) NOT NULL,
	"notification_id" text NOT NULL,
	"event_type" varchar(60) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_delivery_events_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "message_delivery_events_event_uq" UNIQUE("tenant_id","provider","provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "message_suppressions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"channel" "contact_channel" NOT NULL,
	"destination_hash" varchar(64) NOT NULL,
	"reason" varchar(24) NOT NULL,
	"notification_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_suppressions_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "message_suppressions_destination_uq" UNIQUE("tenant_id","channel","destination_hash"),
	CONSTRAINT "message_suppressions_reason_valid" CHECK ("message_suppressions"."reason" in ('bounced', 'complained'))
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "manage_token_ciphertext" text;--> statement-breakpoint
ALTER TABLE "message_delivery_events" ADD CONSTRAINT "message_delivery_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_delivery_events" ADD CONSTRAINT "message_delivery_events_notification_fk" FOREIGN KEY ("tenant_id","notification_id") REFERENCES "public"."notifications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_suppressions" ADD CONSTRAINT "message_suppressions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_provider_message_idx" ON "notifications" USING btree ("provider_message_id");--> statement-breakpoint
-- Feature 2: email delivery. Both new tables hold one business's rows only.
ALTER TABLE "message_suppressions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_suppressions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "message_suppressions"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "message_delivery_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_delivery_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "message_delivery_events"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
-- The email provider's webhook names a message by the provider's id only. This finds which
-- business and which notification it belongs to, and returns those two ids and nothing else.
-- The webhook then opens that business's scope to read and write, as every request does.
CREATE OR REPLACE FUNCTION "kalendr_resolve_email_notification"("p_provider_message_id" text)
RETURNS TABLE ("tenant_id" text, "notification_id" text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_resolve_email_notification$
  SELECT notification.tenant_id, notification.id
  FROM public.notifications AS notification
  WHERE length(coalesce(p_provider_message_id, '')) BETWEEN 1 AND 200
    AND notification.provider_message_id = p_provider_message_id
    AND notification.channel = 'email'
  ORDER BY notification.created_at
  LIMIT 1
$kalendr_resolve_email_notification$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_email_notification"(text) FROM PUBLIC;
