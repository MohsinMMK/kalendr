CREATE TABLE "import_jobs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" varchar(16) NOT NULL,
	"file_format" varchar(8) NOT NULL,
	"file_key" varchar(300),
	"key_version" integer DEFAULT 0 NOT NULL,
	"file_bytes" integer NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(12) DEFAULT 'uploaded' NOT NULL,
	"ready_count" integer DEFAULT 0 NOT NULL,
	"update_count" integer DEFAULT 0 NOT NULL,
	"skip_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"failure_code" varchar(40),
	"started_by_user_id" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"undo_until" timestamp with time zone,
	"undone_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_jobs_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "import_jobs_kind_ck" CHECK ("import_jobs"."kind" in ('customers', 'services', 'appointments')),
	CONSTRAINT "import_jobs_format_ck" CHECK ("import_jobs"."file_format" in ('csv', 'xlsx')),
	CONSTRAINT "import_jobs_status_ck" CHECK ("import_jobs"."status" in ('uploaded', 'mapped', 'checking', 'checked', 'queued', 'running', 'done', 'failed', 'undoing', 'undone'))
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"job_id" text NOT NULL,
	"row_number" integer NOT NULL,
	"status" varchar(12) NOT NULL,
	"error_code" varchar(40),
	"error_field" varchar(40),
	"entity_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_rows_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "import_rows_job_row_uq" UNIQUE("tenant_id","job_id","row_number"),
	CONSTRAINT "import_rows_status_ck" CHECK ("import_rows"."status" in ('ready', 'will_update', 'will_skip', 'error', 'created', 'updated', 'skipped', 'failed', 'undone'))
);
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."import_jobs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_jobs_list_idx" ON "import_jobs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "import_rows_status_idx" ON "import_rows" USING btree ("tenant_id","job_id","status");--> statement-breakpoint
ALTER TABLE "import_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "import_jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "import_jobs"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "import_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "import_rows" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "import_rows"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
-- Which businesses have an import whose undo window has closed and whose file is still stored. Ids only, like kalendr_storage_tenants.
CREATE OR REPLACE FUNCTION "kalendr_import_tenants"() RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_import_tenants$
  select distinct job.tenant_id from import_jobs as job
  where job.file_key is not null
    and (job.status in ('failed', 'undone') or (job.status = 'done' and job.undo_until < now()) or (job.status in ('uploaded', 'mapped', 'checked') and job.updated_at < now() - interval '2 days'))
$kalendr_import_tenants$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_import_tenants"() FROM PUBLIC;
