CREATE TABLE "staff_notifications" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"kind" varchar(40) NOT NULL,
	"title" varchar(140) NOT NULL,
	"link" varchar(200),
	"dedupe_key" varchar(160) NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_notifications_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "staff_notifications_dedupe_uq" UNIQUE("tenant_id","membership_id","dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_type" varchar(10) NOT NULL,
	"membership_id" text,
	"patient_id" text,
	"endpoint_hash" varchar(64) NOT NULL,
	"subscription_ciphertext" text NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	CONSTRAINT "push_subscriptions_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "push_subscriptions_endpoint_uq" UNIQUE("tenant_id","endpoint_hash"),
	CONSTRAINT "push_subscriptions_owner_ck" CHECK (("push_subscriptions"."owner_type" = 'staff' and "push_subscriptions"."membership_id" is not null and "push_subscriptions"."patient_id" is null)
      or ("push_subscriptions"."owner_type" = 'customer' and "push_subscriptions"."patient_id" is not null and "push_subscriptions"."membership_id" is null))
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"kind" varchar(40) NOT NULL,
	"in_app" boolean DEFAULT true NOT NULL,
	"push" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "notification_preferences_kind_uq" UNIQUE("tenant_id","membership_id","kind")
);
--> statement-breakpoint
ALTER TABLE "staff_notifications" ADD CONSTRAINT "staff_notifications_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_notifications" ADD CONSTRAINT "staff_notifications_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_notifications_inbox_idx" ON "staff_notifications" USING btree ("tenant_id","membership_id","created_at");--> statement-breakpoint
CREATE INDEX "push_subscriptions_staff_idx" ON "push_subscriptions" USING btree ("tenant_id","membership_id");--> statement-breakpoint
CREATE INDEX "push_subscriptions_patient_idx" ON "push_subscriptions" USING btree ("tenant_id","patient_id");--> statement-breakpoint
ALTER TABLE "staff_notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "staff_notifications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "staff_notifications"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "push_subscriptions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "push_subscriptions"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_preferences" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notification_preferences"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
-- A new alert reaches other open screens of the same business, so the bell updates at once.
CREATE TRIGGER "staff_notifications_live" AFTER INSERT OR UPDATE ON "staff_notifications"
  FOR EACH ROW EXECUTE FUNCTION "kalendr_notify_live"('notification');
--> statement-breakpoint
-- Same as 0027, plus push subscriptions: a business with subscriptions on an older key still needs re-encrypting.
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
