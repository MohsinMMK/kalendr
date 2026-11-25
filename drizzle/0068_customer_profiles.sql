CREATE TABLE "customer_field_definitions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"label" varchar(60) NOT NULL,
	"kind" varchar(8) NOT NULL,
	"choices" text[] DEFAULT '{}'::text[] NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_field_definitions_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_field_definitions_kind_ck" CHECK ("customer_field_definitions"."kind" in ('text', 'number', 'date', 'choice')),
	CONSTRAINT "customer_field_definitions_choices_ck" CHECK (cardinality("customer_field_definitions"."choices") <= 30)
);
--> statement-breakpoint
CREATE TABLE "customer_field_values" (
	"tenant_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"field_id" text NOT NULL,
	"value" text NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_field_values_pk" PRIMARY KEY("tenant_id","patient_id","field_id"),
	CONSTRAINT "customer_field_values_length_ck" CHECK (char_length("customer_field_values"."value") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "customer_merges" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"kept_patient_id" text NOT NULL,
	"merged_patient_id" text NOT NULL,
	"merged_by_user_id" text,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undo_until" timestamp with time zone NOT NULL,
	"snapshot_ciphertext" text,
	"snapshot_key_version" integer DEFAULT 0 NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by_user_id" text,
	CONSTRAINT "customer_merges_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_merges_distinct_ck" CHECK ("customer_merges"."kept_patient_id" <> "customer_merges"."merged_patient_id")
);
--> statement-breakpoint
CREATE TABLE "customer_notes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"author_user_id" text,
	"author_name" varchar(120) NOT NULL,
	"body" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_notes_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_notes_body_ck" CHECK (char_length("customer_notes"."body") between 1 and 4000)
);
--> statement-breakpoint
CREATE TABLE "customer_segments" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"name" varchar(80) NOT NULL,
	"filter" jsonb NOT NULL,
	"created_by_user_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_segments_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "customer_tag_links" (
	"tenant_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"tag_id" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_tag_links_pk" PRIMARY KEY("tenant_id","patient_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "customer_tags" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"name" varchar(40) NOT NULL,
	"color" varchar(12) DEFAULT 'gray' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_tags_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_tags_color_ck" CHECK ("customer_tags"."color" in ('gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'))
);
--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "block_reason" varchar(200);--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "blocked_by_user_id" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "merged_into_id" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_field_definitions" ADD CONSTRAINT "customer_field_definitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_field_values" ADD CONSTRAINT "customer_field_values_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_field_values" ADD CONSTRAINT "customer_field_values_field_fk" FOREIGN KEY ("tenant_id","field_id") REFERENCES "public"."customer_field_definitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_merges" ADD CONSTRAINT "customer_merges_kept_fk" FOREIGN KEY ("tenant_id","kept_patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_merges" ADD CONSTRAINT "customer_merges_merged_fk" FOREIGN KEY ("tenant_id","merged_patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_segments" ADD CONSTRAINT "customer_segments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tag_links" ADD CONSTRAINT "customer_tag_links_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "public"."patients"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tag_links" ADD CONSTRAINT "customer_tag_links_tag_fk" FOREIGN KEY ("tenant_id","tag_id") REFERENCES "public"."customer_tags"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tags" ADD CONSTRAINT "customer_tags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_field_definitions_label_uq" ON "customer_field_definitions" USING btree ("tenant_id",lower("label"));--> statement-breakpoint
CREATE UNIQUE INDEX "customer_merges_active_uq" ON "customer_merges" USING btree ("tenant_id","merged_patient_id") WHERE "customer_merges"."undone_at" is null;--> statement-breakpoint
CREATE INDEX "customer_merges_kept_idx" ON "customer_merges" USING btree ("tenant_id","kept_patient_id","merged_at");--> statement-breakpoint
CREATE INDEX "customer_notes_patient_idx" ON "customer_notes" USING btree ("tenant_id","patient_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_segments_name_uq" ON "customer_segments" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE INDEX "customer_tag_links_tag_idx" ON "customer_tag_links" USING btree ("tenant_id","tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_tags_name_uq" ON "customer_tags" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE INDEX "patients_tenant_merged_idx" ON "patients" USING btree ("tenant_id","merged_into_id") WHERE "patients"."merged_into_id" is not null;--> statement-breakpoint
CREATE INDEX "patients_tenant_blocked_idx" ON "patients" USING btree ("tenant_id") WHERE "patients"."blocked_at" is not null;
--> statement-breakpoint
ALTER TABLE "customer_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_tags" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_tags" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "customer_tag_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_tag_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_tag_links" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "customer_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_notes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_notes" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "customer_segments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_segments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_segments" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "customer_field_definitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_field_definitions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_field_definitions" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "customer_field_values" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_field_values" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_field_values" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "customer_merges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_merges" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_merges" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
--> statement-breakpoint
-- Staff search matches anywhere in a name, email or phone (ilike '%x%'), which a plain b-tree cannot serve.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE INDEX "patients_fullname_trgm_idx" ON "patients" USING gin (((first_name || ' ' || last_name)) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "patients_email_trgm_idx" ON "patients" USING gin ("email" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "patients_phone_digits_trgm_idx" ON "patients" USING gin ((regexp_replace("phone", '\D', '', 'g')) gin_trgm_ops);
--> statement-breakpoint
-- The profile timeline reads "changes to this customer" from the audit trail by the customer id in its metadata.
CREATE INDEX "audit_events_patient_idx" ON "audit_events" ("tenant_id", (("metadata" ->> 'patientId')), "occurred_at" DESC) WHERE "metadata" ? 'patientId';
--> statement-breakpoint
-- Which businesses have customer work for the worker, by job. Returns ids only, like the other tenant lists.
--   merge_purge: a merge whose 30 days to undo it have passed and whose saved details are still held
CREATE FUNCTION "kalendr_crm_tenants"("p_job" text) RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $kalendr_crm_tenants$
  select distinct merge.tenant_id from customer_merges as merge
  where "p_job" = 'merge_purge' and merge.snapshot_ciphertext is not null and merge.undo_until < now()
$kalendr_crm_tenants$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "kalendr_crm_tenants"(text) FROM PUBLIC;
