CREATE TABLE "form_definition_services" (
	"tenant_id" text NOT NULL,
	"form_definition_id" text NOT NULL,
	"service_id" text NOT NULL,
	CONSTRAINT "form_definition_services_pk" PRIMARY KEY("tenant_id","form_definition_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "form_definitions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"key" varchar(120) NOT NULL,
	"version" integer NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"fields" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"applies_to_all" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_definitions_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "form_definitions_key_version_uq" UNIQUE("tenant_id","key","version"),
	CONSTRAINT "form_definitions_version_positive" CHECK ("form_definitions"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "form_definition_services" ADD CONSTRAINT "form_definition_services_form_fk" FOREIGN KEY ("tenant_id","form_definition_id") REFERENCES "public"."form_definitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_definition_services" ADD CONSTRAINT "form_definition_services_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_definitions" ADD CONSTRAINT "form_definitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_definitions_current_idx" ON "form_definitions" USING btree ("tenant_id","is_current","is_active");--> statement-breakpoint
ALTER TABLE "form_definitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "form_definitions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "form_definitions"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "form_definition_services" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "form_definition_services" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "form_definition_services"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
