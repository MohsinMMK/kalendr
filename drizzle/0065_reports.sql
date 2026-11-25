CREATE TABLE "report_exports" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"report" varchar(24) NOT NULL,
	"params" jsonb NOT NULL,
	"scope" jsonb NOT NULL,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"filename" varchar(120),
	"body" text,
	"failure_code" varchar(40),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "report_exports_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "report_exports_status_ck" CHECK ("report_exports"."status" in ('pending', 'ready', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_exports_user_idx" ON "report_exports" USING btree ("tenant_id","requested_by_user_id","created_at");--> statement-breakpoint
ALTER TABLE "report_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "report_exports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "report_exports" FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
