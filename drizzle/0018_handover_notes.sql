CREATE TABLE "handover_notes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"tenant_id" text NOT NULL,
	"author_user_id" text,
	"author_name" varchar(120) NOT NULL,
	"body" varchar(280) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "handover_notes" ADD CONSTRAINT "handover_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handover_notes_tenant_created_idx" ON "handover_notes" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "handover_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "handover_notes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "handover_notes"
  FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
