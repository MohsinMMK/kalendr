CREATE TABLE "calendar_connections" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"provider" varchar(12) NOT NULL,
	"account_email" varchar(254),
	"credentials_ciphertext" text NOT NULL,
	"key_version" integer NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"last_error_code" varchar(60),
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_connections_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "calendar_connections_provider_ck" CHECK ("calendar_connections"."provider" in ('google', 'microsoft', 'apple')),
	CONSTRAINT "calendar_connections_status_ck" CHECK ("calendar_connections"."status" in ('pending', 'active', 'needs_reconnect', 'disconnecting'))
);
--> statement-breakpoint
CREATE TABLE "calendar_selections" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"calendar_id" varchar(400) NOT NULL,
	"name" varchar(200) NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"can_write" boolean DEFAULT false NOT NULL,
	"blocks_availability" boolean DEFAULT false NOT NULL,
	"writes_here" boolean DEFAULT false NOT NULL,
	"sync_token" text,
	"channel_id" varchar(200),
	"channel_resource_id" varchar(400),
	"channel_expires_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_snapshot_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_selections_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "calendar_selections_calendar_uq" UNIQUE("tenant_id","connection_id","calendar_id"),
	CONSTRAINT "calendar_selections_writes_ck" CHECK (not "calendar_selections"."writes_here" or "calendar_selections"."can_write")
);
--> statement-breakpoint
CREATE TABLE "external_busy" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"selection_id" text NOT NULL,
	"source_event_id" varchar(600) NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_busy_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "external_busy_event_uq" UNIQUE("tenant_id","selection_id","source_event_id"),
	CONSTRAINT "external_busy_time_order_ck" CHECK ("external_busy"."ends_at" > "external_busy"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "appointment_event_links" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"selection_id" text NOT NULL,
	"event_id" varchar(600) NOT NULL,
	"etag" text,
	"fields_hash" varchar(64) NOT NULL,
	"pushed_starts_at" timestamp with time zone NOT NULL,
	"pushed_ends_at" timestamp with time zone NOT NULL,
	"status" varchar(12) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_event_links_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "appointment_event_links_appointment_uq" UNIQUE("tenant_id","appointment_id","selection_id"),
	CONSTRAINT "appointment_event_links_event_uq" UNIQUE("tenant_id","selection_id","event_id"),
	CONSTRAINT "appointment_event_links_status_ck" CHECK ("appointment_event_links"."status" in ('active', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "calendar_webhook_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"provider" varchar(12) NOT NULL,
	"event_key" varchar(400) NOT NULL,
	"selection_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_webhook_events_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "calendar_webhook_events_key_uq" UNIQUE("tenant_id","provider","event_key")
);
--> statement-breakpoint
CREATE TABLE "calendar_feed_tokens" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_feed_tokens_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "calendar_feed_tokens_member_uq" UNIQUE("tenant_id","membership_id"),
	CONSTRAINT "calendar_feed_tokens_hash_uq" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "calendar_conflicts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"selection_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"kind" varchar(10) NOT NULL,
	"appointment_starts_at" timestamp with time zone NOT NULL,
	"appointment_ends_at" timestamp with time zone NOT NULL,
	"event_starts_at" timestamp with time zone,
	"event_ends_at" timestamp with time zone,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_conflicts_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "calendar_conflicts_kind_ck" CHECK ("calendar_conflicts"."kind" in ('moved', 'deleted')),
	CONSTRAINT "calendar_conflicts_status_ck" CHECK ("calendar_conflicts"."status" in ('open', 'moved_appointment', 'restored_event', 'dismissed', 'obsolete'))
);
--> statement-breakpoint
CREATE TABLE "calendar_business_settings" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"event_text" varchar(24) DEFAULT 'busy_only' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_business_settings_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "calendar_business_settings_tenant_uq" UNIQUE("tenant_id"),
	CONSTRAINT "calendar_business_settings_text_ck" CHECK ("calendar_business_settings"."event_text" in ('full', 'first_name_service', 'busy_only'))
);
--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_selections" ADD CONSTRAINT "calendar_selections_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_selections" ADD CONSTRAINT "calendar_selections_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."calendar_connections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_selections" ADD CONSTRAINT "calendar_selections_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_busy" ADD CONSTRAINT "external_busy_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_busy" ADD CONSTRAINT "external_busy_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_busy" ADD CONSTRAINT "external_busy_selection_fk" FOREIGN KEY ("tenant_id","selection_id") REFERENCES "public"."calendar_selections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_event_links" ADD CONSTRAINT "appointment_event_links_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_event_links" ADD CONSTRAINT "appointment_event_links_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_event_links" ADD CONSTRAINT "appointment_event_links_selection_fk" FOREIGN KEY ("tenant_id","selection_id") REFERENCES "public"."calendar_selections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_webhook_events" ADD CONSTRAINT "calendar_webhook_events_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed_tokens" ADD CONSTRAINT "calendar_feed_tokens_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed_tokens" ADD CONSTRAINT "calendar_feed_tokens_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_conflicts" ADD CONSTRAINT "calendar_conflicts_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_conflicts" ADD CONSTRAINT "calendar_conflicts_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_conflicts" ADD CONSTRAINT "calendar_conflicts_selection_fk" FOREIGN KEY ("tenant_id","selection_id") REFERENCES "public"."calendar_selections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_conflicts" ADD CONSTRAINT "calendar_conflicts_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_business_settings" ADD CONSTRAINT "calendar_business_settings_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_connections_member_idx" ON "calendar_connections" USING btree ("tenant_id","membership_id");--> statement-breakpoint
CREATE INDEX "calendar_selections_connection_idx" ON "calendar_selections" USING btree ("tenant_id","connection_id");--> statement-breakpoint
CREATE INDEX "calendar_selections_channel_idx" ON "calendar_selections" USING btree ("channel_id") WHERE "channel_id" is not null;--> statement-breakpoint
CREATE INDEX "calendar_selections_expiry_idx" ON "calendar_selections" USING btree ("channel_expires_at") WHERE "channel_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_selections_one_writer_uq" ON "calendar_selections" USING btree ("tenant_id","membership_id") WHERE "writes_here";--> statement-breakpoint
CREATE INDEX "external_busy_lookup_idx" ON "external_busy" USING btree ("tenant_id","membership_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "appointment_event_links_selection_idx" ON "appointment_event_links" USING btree ("tenant_id","selection_id");--> statement-breakpoint
CREATE INDEX "calendar_webhook_events_received_idx" ON "calendar_webhook_events" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_conflicts_open_uq" ON "calendar_conflicts" USING btree ("tenant_id","appointment_id","selection_id") WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX "calendar_conflicts_list_idx" ON "calendar_conflicts" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
ALTER TABLE "calendar_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_connections"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "calendar_selections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_selections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_selections"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "external_busy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "external_busy" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "external_busy"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "appointment_event_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appointment_event_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appointment_event_links"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "calendar_webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_webhook_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_webhook_events"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "calendar_feed_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_feed_tokens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_feed_tokens"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "calendar_conflicts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_conflicts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_conflicts"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "calendar_business_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_business_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_business_settings"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
-- A calendar provider's notification names only a channel. These two functions turn that into a business
-- and a calendar so the webhook can work inside the business's own scope. Ids only, nothing else.
CREATE OR REPLACE FUNCTION "kalendr_resolve_calendar_channel"("p_channel" text)
  RETURNS TABLE ("tenant_id" text, "selection_id" text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_resolve_calendar_channel$
  select selection.tenant_id, selection.id from calendar_selections as selection
  where selection.channel_id = "p_channel" limit 1
$kalendr_resolve_calendar_channel$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_calendar_channel"(text) FROM PUBLIC;--> statement-breakpoint
-- The private calendar feed address carries a token; this finds the person it belongs to from the token's hash.
CREATE OR REPLACE FUNCTION "kalendr_resolve_calendar_feed"("p_hash" text)
  RETURNS TABLE ("tenant_id" text, "membership_id" text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_resolve_calendar_feed$
  select feed.tenant_id, feed.membership_id from calendar_feed_tokens as feed
  join memberships as membership on membership.tenant_id = feed.tenant_id and membership.id = feed.membership_id
  where feed.token_hash = "p_hash" and membership.is_active limit 1
$kalendr_resolve_calendar_feed$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_resolve_calendar_feed"(text) FROM PUBLIC;--> statement-breakpoint
-- Which businesses have calendar work for a timed job. Ids only, like kalendr_worker_tenants.
--   renew: a watch channel expires within 25 hours, or a push calendar has lost its channel
--   poll: calendars that cannot ping us (Apple, or Google and Outlook with no channel), read every few minutes
--   resnapshot: calendars not fully re-read for 20 hours, so the cached window never goes stale
--   cleanup (also run with resnapshot): webhook records older than a week
CREATE OR REPLACE FUNCTION "kalendr_calendar_tenants"("p_job" text) RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_calendar_tenants$
  select distinct selection.tenant_id from calendar_selections as selection
  join calendar_connections as connection on connection.tenant_id = selection.tenant_id and connection.id = selection.connection_id
  where connection.status = 'active' and (
    ("p_job" = 'renew' and connection.provider in ('google', 'microsoft') and (selection.blocks_availability or selection.writes_here)
      and (selection.channel_id is null or selection.channel_expires_at < now() + interval '25 hours'))
    or ("p_job" = 'poll' and (selection.blocks_availability or selection.writes_here)
      and (connection.provider = 'apple' or selection.channel_id is null))
    or ("p_job" = 'resnapshot' and connection.provider in ('google', 'microsoft') and selection.blocks_availability
      and (selection.last_snapshot_at is null or selection.last_snapshot_at < now() - interval '20 hours'))
  )
  union
  select event.tenant_id from calendar_webhook_events as event
  where "p_job" in ('cleanup', 'resnapshot') and event.received_at < now() - interval '7 days'
$kalendr_calendar_tenants$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_calendar_tenants"(text) FROM PUBLIC;--> statement-breakpoint
-- Same as 0030, plus calendar logins: a business with calendar tokens on an older key still needs re-encrypting.
CREATE OR REPLACE FUNCTION "kalendr_storage_tenants"("p_job" text) RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_storage_tenants$
  -- Which businesses have storage work for one worker job. Ids only, no row content.
  with business as (
    select tenant.id,
      greatest(coalesce((select max(data_key.version) from tenant_data_keys as data_key where data_key.tenant_id = tenant.id), 0), 1) as target
    from tenants as tenant
  )
  select business.id from business
  where case "p_job"
    when 're_encrypt' then
      exists (select 1 from visit_records as record where record.tenant_id = business.id and record.key_version < business.target)
      or exists (select 1 from visit_record_files as file where file.tenant_id = business.id and file.key_version < business.target and file.scan_status in ('clean', 'skipped'))
      or exists (select 1 from forms as form where form.tenant_id = business.id and form.response_ciphertext is not null and form.key_version < business.target)
      or exists (select 1 from media_assets as media where media.tenant_id = business.id and media.storage_key is not null and media.key_version < business.target and media.scan_status in ('clean', 'skipped'))
      or exists (select 1 from push_subscriptions as subscription where subscription.tenant_id = business.id and subscription.key_version < business.target)
      or exists (select 1 from calendar_connections as connection where connection.tenant_id = business.id and connection.key_version < business.target)
      or exists (select 1 from tenant_data_keys as data_key where data_key.tenant_id = business.id and data_key.version < business.target and data_key.retired_at is null)
      or (exists (select 1 from tenant_data_keys as data_key where data_key.tenant_id = business.id and data_key.version > 0)
        and not exists (select 1 from tenant_data_keys as data_key where data_key.tenant_id = business.id and data_key.version = 0))
    when 'rotate_due' then
      exists (select 1 from tenant_data_keys as data_key
        where data_key.tenant_id = business.id and data_key.version = business.target and data_key.version > 0
          and data_key.created_at < now() - interval '365 days')
    when 'media_backfill' then
      exists (select 1 from media_assets as media where media.tenant_id = business.id and media.storage_key is null)
      or exists (select 1 from practitioners as practitioner where practitioner.tenant_id = business.id and practitioner.photo_data_url is not null)
    else false
  end
  order by business.id
$kalendr_storage_tenants$;
