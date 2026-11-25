CREATE TABLE "service_templates" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"name" varchar(120) NOT NULL,
	"settings" jsonb NOT NULL,
	"locked_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_templates_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_templates_version_ck" CHECK ("service_templates"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "template_id" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "template_version" integer;--> statement-breakpoint
ALTER TABLE "service_templates" ADD CONSTRAINT "service_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_templates_tenant_idx" ON "service_templates" USING btree ("tenant_id","name");--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."service_templates"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "services_template_idx" ON "services" USING btree ("tenant_id","template_id") WHERE "services"."template_id" is not null;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_template_pair_ck" CHECK (("services"."template_id" is null) = ("services"."template_version" is null));
--> statement-breakpoint
-- Feature 48, the hand-written part: forced row-level security on the new table.
ALTER TABLE "service_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "service_templates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "service_templates"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
