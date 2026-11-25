CREATE TABLE "tenant_data_keys" (
	"tenant_id" text NOT NULL,
	"version" integer NOT NULL,
	"provider" varchar(16) NOT NULL,
	"wrapped_key" "bytea",
	"master_key_id" varchar(2048),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "tenant_data_keys_pk" PRIMARY KEY("tenant_id","version"),
	CONSTRAINT "tenant_data_keys_provider_valid" CHECK ("tenant_data_keys"."provider" in ('legacy', 'local', 'kms')),
	CONSTRAINT "tenant_data_keys_shape_valid" CHECK (("tenant_data_keys"."provider" = 'legacy' and "tenant_data_keys"."version" = 0 and "tenant_data_keys"."wrapped_key" is null)
      or ("tenant_data_keys"."provider" <> 'legacy' and "tenant_data_keys"."version" > 0 and "tenant_data_keys"."wrapped_key" is not null and "tenant_data_keys"."master_key_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "media_assets" DROP CONSTRAINT "media_assets_kind_valid";--> statement-breakpoint
ALTER TABLE "media_assets" DROP CONSTRAINT "media_assets_content_type_valid";--> statement-breakpoint
ALTER TABLE "media_assets" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "key_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "storage_key" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "key_version" integer;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "scan_status" varchar(16) DEFAULT 'skipped' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ALTER COLUMN "scan_status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "visit_record_files" ADD COLUMN "key_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "visit_record_files" ADD COLUMN "scan_status" varchar(16) DEFAULT 'skipped' NOT NULL;--> statement-breakpoint
ALTER TABLE "visit_record_files" ALTER COLUMN "scan_status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "visit_record_files" ADD COLUMN "scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visit_records" ADD COLUMN "key_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_data_keys" ADD CONSTRAINT "tenant_data_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_scan_status_valid" CHECK ("media_assets"."scan_status" in ('pending', 'clean', 'infected', 'skipped'));--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_bytes_present" CHECK ("media_assets"."data" is not null or ("media_assets"."storage_key" is not null and "media_assets"."key_version" is not null));--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_kind_valid" CHECK ("media_assets"."kind" in ('business_logo', 'business_cover', 'service', 'practitioner'));--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_content_type_valid" CHECK ("media_assets"."content_type" in ('image/jpeg', 'image/webp', 'image/png'));--> statement-breakpoint
ALTER TABLE "visit_record_files" ADD CONSTRAINT "visit_record_files_scan_status_valid" CHECK ("visit_record_files"."scan_status" in ('pending', 'clean', 'infected', 'skipped'));--> statement-breakpoint
ALTER TABLE "tenant_data_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_data_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_data_keys" FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
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
$kalendr_storage_tenants$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_storage_tenants"(text) FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "kalendr_storage_health"()
  RETURNS TABLE ("records_on_old_keys" bigint, "files_waiting_for_scan" bigint, "pictures_to_move" bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_storage_health$
  -- Counts only, across every business, for the worker's log line.
  with target as (
    select tenant.id as tenant_id,
      greatest(coalesce((select max(data_key.version) from tenant_data_keys as data_key where data_key.tenant_id = tenant.id), 0), 1) as version
    from tenants as tenant
  )
  select
    (select count(*) from visit_records as record join target on target.tenant_id = record.tenant_id where record.key_version < target.version)
      + (select count(*) from visit_record_files as file join target on target.tenant_id = file.tenant_id where file.key_version < target.version and file.scan_status in ('clean', 'skipped'))
      + (select count(*) from forms as form join target on target.tenant_id = form.tenant_id where form.response_ciphertext is not null and form.key_version < target.version)
      + (select count(*) from media_assets as media join target on target.tenant_id = media.tenant_id where media.storage_key is not null and media.key_version < target.version and media.scan_status in ('clean', 'skipped')),
    (select count(*) from visit_record_files where scan_status = 'pending')
      + (select count(*) from media_assets where scan_status = 'pending'),
    (select count(*) from media_assets where storage_key is null)
      + (select count(*) from practitioners where photo_data_url is not null)
$kalendr_storage_health$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_storage_health"() FROM PUBLIC;