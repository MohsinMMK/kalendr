CREATE TABLE "message_templates" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"channel" "contact_channel" NOT NULL,
	"key" varchar(80) NOT NULL,
	"language" varchar(16) DEFAULT 'en' NOT NULL,
	"provider_name" varchar(120) NOT NULL,
	"provider_template_id" varchar(80),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"status_reason" varchar(120),
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"buttons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"body" text,
	"cost_category" varchar(16) DEFAULT 'utility' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_templates_uq" UNIQUE("channel","key","language"),
	CONSTRAINT "message_templates_status_valid" CHECK ("message_templates"."status" in ('pending', 'approved', 'rejected', 'paused')),
	CONSTRAINT "message_templates_cost_valid" CHECK ("message_templates"."cost_category" in ('utility', 'marketing', 'authentication', 'service'))
);
--> statement-breakpoint
CREATE TABLE "message_threads" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"channel" "contact_channel" DEFAULT 'whatsapp' NOT NULL,
	"contact_hash" varchar(64) NOT NULL,
	"whatsapp_account_id" text,
	"assigned_to_user_id" text,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_outbound_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"window_closes_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_threads_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "message_threads_patient_channel_uq" UNIQUE("tenant_id","patient_id","channel")
);
--> statement-breakpoint
CREATE TABLE "short_links" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "short_links_code_uq" UNIQUE("code_hash"),
	CONSTRAINT "short_links_appointment_uq" UNIQUE("tenant_id","appointment_id")
);
--> statement-breakpoint
CREATE TABLE "tenant_channel_settings" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"whatsapp_enabled" boolean DEFAULT true NOT NULL,
	"sms_enabled" boolean DEFAULT true NOT NULL,
	"whatsapp_account_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"direction" varchar(8) NOT NULL,
	"kind" varchar(12) NOT NULL,
	"body_ciphertext" text,
	"key_version" integer,
	"template_key" varchar(80),
	"provider_message_id" varchar(200),
	"status" varchar(12) NOT NULL,
	"failure_code" varchar(120),
	"appointment_id" text,
	"notification_id" text,
	"sent_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "messages_provider_id_uq" UNIQUE("tenant_id","provider_message_id"),
	CONSTRAINT "messages_direction_valid" CHECK ("messages"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "messages_kind_valid" CHECK ("messages"."kind" in ('text', 'template', 'button', 'other')),
	CONSTRAINT "messages_status_valid" CHECK ("messages"."status" in ('received', 'queued', 'sent', 'delivered', 'read', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "cost_category" varchar(16);--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "segments" smallint;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_channel_settings" ADD CONSTRAINT "tenant_channel_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_fk" FOREIGN KEY ("tenant_id","thread_id") REFERENCES "public"."message_threads"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_threads_inbox_idx" ON "message_threads" USING btree ("tenant_id","last_message_at");--> statement-breakpoint
CREATE INDEX "message_threads_contact_idx" ON "message_threads" USING btree ("contact_hash","channel");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("tenant_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_provider_idx" ON "messages" USING btree ("provider_message_id");--> statement-breakpoint
-- Features 3 and 4: WhatsApp inbox and SMS. Four tables hold one business's rows only.
DO $kalendr_channels_rls$
DECLARE tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY['tenant_channel_settings', 'message_threads', 'messages', 'short_links']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), ''''))',
      tenant_table
    );
  END LOOP;
END
$kalendr_channels_rls$;--> statement-breakpoint
-- A provider's callback names a message by the provider's id only. These find which business it
-- belongs to and return ids, nothing else; the webhook then opens that business's scope.
CREATE OR REPLACE FUNCTION "kalendr_resolve_provider_message"("p_channel" text, "p_provider_message_id" text)
RETURNS TABLE ("tenant_id" text, "notification_id" text, "message_id" text, "thread_id" text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_resolve_provider_message$
  WITH asked AS (
    SELECT p_provider_message_id AS id WHERE length(coalesce(p_provider_message_id, '')) BETWEEN 1 AND 200
  ),
  sent AS (
    SELECT notification.tenant_id, notification.id
    FROM public.notifications AS notification, asked
    WHERE notification.provider_message_id = asked.id AND notification.channel::text = p_channel
    ORDER BY notification.created_at LIMIT 1
  ),
  thread_message AS (
    SELECT message.tenant_id, message.id, message.thread_id
    FROM public.messages AS message, asked
    WHERE message.provider_message_id = asked.id
    ORDER BY message.created_at LIMIT 1
  )
  SELECT coalesce(sent.tenant_id, thread_message.tenant_id), sent.id, thread_message.id, thread_message.thread_id
  FROM (SELECT 1) AS one
  LEFT JOIN sent ON true
  LEFT JOIN thread_message ON true
  WHERE sent.id IS NOT NULL OR thread_message.id IS NOT NULL
$kalendr_resolve_provider_message$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_provider_message"(text, text) FROM PUBLIC;--> statement-breakpoint
-- A customer's free-text reply names only their number. Every business that has written to that
-- number on this channel is returned, most recent first. A reply goes to the first; STOP goes to all.
CREATE OR REPLACE FUNCTION "kalendr_resolve_inbound_threads"("p_channel" text, "p_contact_hash" text)
RETURNS TABLE ("tenant_id" text, "thread_id" text, "patient_id" text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_resolve_inbound_threads$
  SELECT thread.tenant_id, thread.id, thread.patient_id
  FROM public.message_threads AS thread
  JOIN public.tenants AS tenant ON tenant.id = thread.tenant_id AND tenant.is_active
  WHERE thread.channel::text = p_channel AND thread.contact_hash = p_contact_hash
  ORDER BY thread.last_outbound_at DESC NULLS LAST, thread.last_message_at DESC
  LIMIT 20
$kalendr_resolve_inbound_threads$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_inbound_threads"(text, text) FROM PUBLIC;--> statement-breakpoint
-- The short link in an SMS holds only a code. This finds the business and booking, ids only.
CREATE OR REPLACE FUNCTION "kalendr_resolve_short_link"("p_code_hash" text)
RETURNS TABLE ("tenant_id" text, "appointment_id" text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $kalendr_resolve_short_link$
  SELECT link.tenant_id, link.appointment_id
  FROM public.short_links AS link
  WHERE link.code_hash = p_code_hash AND link.expires_at > now()
  LIMIT 1
$kalendr_resolve_short_link$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_short_link"(text) FROM PUBLIC;--> statement-breakpoint
-- Kalendr's own approved templates. Names and ids here are the ones submitted to Meta and to DLT;
-- the owner replaces the SMS ids with the real DLT template ids once approved.
INSERT INTO "message_templates" ("channel", "key", "language", "provider_name", "provider_template_id", "status", "variables", "buttons", "body", "cost_category") VALUES
('whatsapp', 'booking_confirmed', 'en', 'kalendr_booking_confirmed', NULL, 'pending', '["name","business","service","when","link"]', '[]', NULL, 'utility'),
('whatsapp', 'reminder', 'en', 'kalendr_reminder', NULL, 'pending', '["name","business","service","when","link"]', '["Confirm","Reschedule"]', NULL, 'utility'),
('whatsapp', 'rescheduled', 'en', 'kalendr_rescheduled', NULL, 'pending', '["name","business","service","when","link"]', '[]', NULL, 'utility'),
('whatsapp', 'cancelled', 'en', 'kalendr_cancelled', NULL, 'pending', '["name","business","service","when"]', '[]', NULL, 'utility'),
('whatsapp', 'waitlist_offer', 'en', 'kalendr_waitlist_offer', NULL, 'pending', '["name","business","service","when","link"]', '[]', NULL, 'utility'),
('whatsapp', 'review_request', 'en', 'kalendr_review_request', NULL, 'pending', '["name","business","link"]', '[]', NULL, 'marketing'),
('whatsapp', 'sign_in_code', 'en', 'kalendr_sign_in_code', NULL, 'pending', '["code"]', '[]', NULL, 'authentication'),
('sms', 'booking_confirmed', 'en', 'booking_confirmed', NULL, 'pending', '["name","business","when","link"]', '[]', 'Hi {#var#}, your booking with {#var#} is confirmed for {#var#}. Manage: {#var#}', 'utility'),
('sms', 'reminder', 'en', 'reminder', NULL, 'pending', '["name","business","when","link"]', '[]', 'Hi {#var#}, a reminder of your booking with {#var#} on {#var#}. Manage: {#var#}', 'utility'),
('sms', 'rescheduled', 'en', 'rescheduled', NULL, 'pending', '["name","business","when","link"]', '[]', 'Hi {#var#}, your booking with {#var#} is now on {#var#}. Manage: {#var#}', 'utility'),
('sms', 'cancelled', 'en', 'cancelled', NULL, 'pending', '["name","business","when","link"]', '[]', 'Hi {#var#}, your booking with {#var#} on {#var#} is cancelled. Book again: {#var#}', 'utility'),
('sms', 'sign_in_code', 'en', 'sign_in_code', NULL, 'pending', '["code"]', '[]', '{#var#} is your Kalendr sign-in code. Do not share it.', 'authentication'),
('sms', 'booking_confirmed', 'hi', 'booking_confirmed_hi', NULL, 'pending', '["name","business","when","link"]', '[]', 'नमस्ते {#var#}, {#var#} के साथ आपकी बुकिंग {#var#} के लिए पक्की है। प्रबंधित करें: {#var#}', 'utility'),
('sms', 'reminder', 'hi', 'reminder_hi', NULL, 'pending', '["name","business","when","link"]', '[]', 'नमस्ते {#var#}, {#var#} के साथ आपकी बुकिंग {#var#} को है। प्रबंधित करें: {#var#}', 'utility');
