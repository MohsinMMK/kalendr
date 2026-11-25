ALTER TYPE "public"."consent_source" ADD VALUE 'unsubscribe_link';--> statement-breakpoint
CREATE TABLE "campaign_sends" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"cycle" varchar(40) DEFAULT '' NOT NULL,
	"channel" varchar(10) NOT NULL,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"reason" varchar(40),
	"send_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"unsubscribe_token_hash" varchar(64) NOT NULL,
	"unsubscribe_token_ciphertext" text,
	"unsubscribed_at" timestamp with time zone,
	"booked_appointment_id" text,
	"booked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_sends_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "campaign_sends_customer_uq" UNIQUE("tenant_id","campaign_id","patient_id","cycle"),
	CONSTRAINT "campaign_sends_status_ck" CHECK ("campaign_sends"."status" in ('pending', 'queued', 'sent', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"name" varchar(120) NOT NULL,
	"kind" varchar(10) NOT NULL,
	"rule_type" varchar(20),
	"rule" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"preset_key" varchar(40),
	"segment_id" text,
	"segment_filter" jsonb,
	"channel" varchar(10) NOT NULL,
	"subject" varchar(200),
	"body" text,
	"template_key" varchar(60),
	"service_id" text,
	"status" varchar(12) DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_run_on" date,
	"paused_reason" varchar(24),
	"tested_version" integer,
	"tested_at" timestamp with time zone,
	"code" varchar(24) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "campaigns_kind_ck" CHECK ("campaigns"."kind" in ('automated', 'one_off')),
	CONSTRAINT "campaigns_channel_ck" CHECK ("campaigns"."channel" in ('email', 'whatsapp', 'sms')),
	CONSTRAINT "campaigns_status_ck" CHECK ("campaigns"."status" in ('draft', 'active', 'paused', 'sending', 'completed', 'cancelled')),
	CONSTRAINT "campaigns_rule_ck" CHECK (("campaigns"."kind" = 'automated') = ("campaigns"."rule_type" is not null) and ("campaigns"."rule_type" is null or "campaigns"."rule_type" in ('recall', 'birthday', 'win_back', 'package_expiring')))
);
--> statement-breakpoint
CREATE TABLE "marketing_preferences" (
	"tenant_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"channel" varchar(10) NOT NULL,
	"opted_in" boolean NOT NULL,
	"source" varchar(20) NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_preferences_pk" PRIMARY KEY("tenant_id","patient_id","channel"),
	CONSTRAINT "marketing_preferences_channel_ck" CHECK ("marketing_preferences"."channel" in ('email', 'whatsapp', 'sms'))
);
--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_campaign_fk" FOREIGN KEY ("tenant_id","campaign_id") REFERENCES "public"."campaigns"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_preferences" ADD CONSTRAINT "marketing_preferences_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_sends_token_uq" ON "campaign_sends" USING btree ("unsubscribe_token_hash");--> statement-breakpoint
CREATE INDEX "campaign_sends_due_idx" ON "campaign_sends" USING btree ("send_at") WHERE "campaign_sends"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "campaign_sends_patient_idx" ON "campaign_sends" USING btree ("tenant_id","patient_id","sent_at");--> statement-breakpoint
CREATE INDEX "campaign_sends_campaign_idx" ON "campaign_sends" USING btree ("tenant_id","campaign_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_code_uq" ON "campaigns" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_preset_uq" ON "campaigns" USING btree ("tenant_id","preset_key") WHERE "campaigns"."preset_key" is not null;--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("tenant_id","status");
--> statement-breakpoint
ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "campaigns" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "campaigns" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "campaign_sends" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "campaign_sends" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "campaign_sends" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "marketing_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "marketing_preferences" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "marketing_preferences" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
-- Marketing templates (feature 28). They go to Meta (WhatsApp, marketing category) and to DLT (promotional text) for
-- approval; nothing is ever sent from one until its status is "approved". Names and ids are the ones to submit.
INSERT INTO "message_templates" ("channel", "key", "language", "provider_name", "provider_template_id", "status", "variables", "buttons", "body", "cost_category") VALUES
('whatsapp', 'campaign_recall', 'en', 'kalendr_campaign_recall', NULL, 'pending', '["name","business","service","link"]', '[]', NULL, 'marketing'),
('whatsapp', 'campaign_birthday', 'en', 'kalendr_campaign_birthday', NULL, 'pending', '["name","business","link"]', '[]', NULL, 'marketing'),
('whatsapp', 'campaign_winback', 'en', 'kalendr_campaign_winback', NULL, 'pending', '["name","business","link"]', '[]', NULL, 'marketing'),
('whatsapp', 'campaign_package', 'en', 'kalendr_campaign_package', NULL, 'pending', '["name","business","link"]', '[]', NULL, 'marketing'),
('whatsapp', 'campaign_offer', 'en', 'kalendr_campaign_offer', NULL, 'pending', '["name","business","message","link"]', '[]', NULL, 'marketing'),
('sms', 'campaign_message', 'en', 'campaign_message', NULL, 'pending', '["name","business","message","link","unsubscribe"]', '[]', 'Hi {#var#}, {#var#}: {#var#} Book: {#var#} Unsubscribe: {#var#}', 'marketing');--> statement-breakpoint
-- Which businesses have campaign work for the worker. Returns ids only, like the other tenant lists.
--   campaign_tick: a campaign that is running, a message waiting to go, or a recent message that may still be credited with a booking
CREATE FUNCTION "kalendr_campaign_tenants"("p_job" text) RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_campaign_tenants$
  select distinct campaign.tenant_id from campaigns as campaign
  where "p_job" = 'campaign_tick' and campaign.status in ('active', 'sending')
  union
  select distinct send.tenant_id from campaign_sends as send
  where "p_job" = 'campaign_tick' and send.status in ('pending', 'queued')
  union
  select distinct send.tenant_id from campaign_sends as send
  where "p_job" = 'campaign_tick' and send.status = 'sent' and send.booked_appointment_id is null and send.sent_at > now() - interval '8 days'
$kalendr_campaign_tenants$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_campaign_tenants"(text) FROM PUBLIC;--> statement-breakpoint
-- The unsubscribe link carries no business and no sign-in. It names a message by the hash of its token, and this function
-- is the one way from that hash to the business and customer, so the public page can run inside the right business.
CREATE FUNCTION "kalendr_resolve_unsubscribe"("p_token_hash" text) RETURNS TABLE (tenant_id text, send_id text, patient_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_resolve_unsubscribe$
  select send.tenant_id, send.id, send.patient_id from campaign_sends as send where send.unsubscribe_token_hash = "p_token_hash" limit 1
$kalendr_resolve_unsubscribe$;
