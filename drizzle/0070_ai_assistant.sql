ALTER TYPE "public"."booking_source" ADD VALUE 'assistant';--> statement-breakpoint
CREATE TABLE "assistant_conversations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"channel" varchar(10) NOT NULL,
	"token_hash" varchar(64),
	"patient_id" text,
	"thread_id" text,
	"staff_user_id" text,
	"status" varchar(12) DEFAULT 'active' NOT NULL,
	"handed_off_at" timestamp with time zone,
	"handoff_reason" varchar(24),
	"summary_ciphertext" text,
	"summary_key_version" integer,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"failure_count" smallint DEFAULT 0 NOT NULL,
	"pending_id" varchar(64),
	"pending_ciphertext" text,
	"pending_key_version" integer,
	"pending_expires_at" timestamp with time zone,
	"otp_phone_ciphertext" text,
	"otp_key_version" integer,
	"otp_sent_at" timestamp with time zone,
	"verified_patient_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"verified_at" timestamp with time zone,
	"shown_appointment_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"lease_until" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_conversations_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "assistant_conversations_token_uq" UNIQUE("token_hash"),
	CONSTRAINT "assistant_conversations_channel_ck" CHECK ("assistant_conversations"."channel" in ('web', 'whatsapp', 'sms', 'staff')),
	CONSTRAINT "assistant_conversations_status_ck" CHECK ("assistant_conversations"."status" in ('active', 'handed_off', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "assistant_messages" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" varchar(10) NOT NULL,
	"content_ciphertext" text NOT NULL,
	"key_version" integer,
	"source_key" varchar(160),
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_messages_seq_uq" UNIQUE("conversation_id","seq"),
	CONSTRAINT "assistant_messages_source_uq" UNIQUE("tenant_id","conversation_id","source_key"),
	CONSTRAINT "assistant_messages_kind_ck" CHECK ("assistant_messages"."kind" in ('customer', 'assistant', 'tool', 'staff'))
);
--> statement-breakpoint
CREATE TABLE "assistant_settings" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"enabled_web" boolean DEFAULT false NOT NULL,
	"enabled_whatsapp" boolean DEFAULT false NOT NULL,
	"enabled_sms" boolean DEFAULT false NOT NULL,
	"tone" varchar(12) DEFAULT 'friendly' NOT NULL,
	"handoff_rule" varchar(10) DEFAULT 'balanced' NOT NULL,
	"business_facts" text,
	"retention_days" smallint DEFAULT 90 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_settings_tenant_uq" UNIQUE("tenant_id"),
	CONSTRAINT "assistant_settings_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "assistant_settings_tone_ck" CHECK ("assistant_settings"."tone" in ('friendly', 'professional', 'concise')),
	CONSTRAINT "assistant_settings_handoff_ck" CHECK ("assistant_settings"."handoff_rule" in ('balanced', 'eager')),
	CONSTRAINT "assistant_settings_retention_ck" CHECK ("assistant_settings"."retention_days" between 7 and 730),
	CONSTRAINT "assistant_settings_facts_ck" CHECK ("assistant_settings"."business_facts" is null or char_length("assistant_settings"."business_facts") <= 3000)
);
--> statement-breakpoint
CREATE TABLE "assistant_usage" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"period" date NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_usage_period_uq" UNIQUE("tenant_id","period"),
	CONSTRAINT "assistant_usage_period_ck" CHECK (extract(day from "assistant_usage"."period") = 1)
);
--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_thread_fk" FOREIGN KEY ("tenant_id","thread_id") REFERENCES "public"."message_threads"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."assistant_conversations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_settings" ADD CONSTRAINT "assistant_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_usage" ADD CONSTRAINT "assistant_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_conversations_inbox_idx" ON "assistant_conversations" USING btree ("tenant_id","status","last_activity_at");--> statement-breakpoint
CREATE INDEX "assistant_conversations_thread_idx" ON "assistant_conversations" USING btree ("tenant_id","thread_id");--> statement-breakpoint
CREATE INDEX "assistant_conversations_patient_idx" ON "assistant_conversations" USING btree ("tenant_id","patient_id");--> statement-breakpoint
CREATE INDEX "assistant_messages_conversation_idx" ON "assistant_messages" USING btree ("tenant_id","conversation_id","seq");--> statement-breakpoint
-- Feature 30, the hand-written part: row-level security on the four assistant tables, like every business table.
ALTER TABLE "assistant_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assistant_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "assistant_settings"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "assistant_conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assistant_conversations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "assistant_conversations"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "assistant_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assistant_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "assistant_messages"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "assistant_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assistant_usage" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "assistant_usage"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
